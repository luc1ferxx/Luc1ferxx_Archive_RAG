// run-retrieval-comparison.mjs
//
// Req-4 effect-evaluation harness: compares the four retrieval arms
//   1. dense-only
//   2. sparse-only        (local backend => BM25 lexical ranking)
//   3. hybrid RRF         (dense + sparse fused by Reciprocal Rank Fusion)
//   4. hybrid + rerank    (hybrid RRF then heuristic or cross-encoder rerank)
// on ONE corpus, with a tuning/held-out split BY SOURCE DOCUMENT so no document
// (or its near-duplicate) appears on both sides.
//
// It reuses the tested IR-metrics harness (runRerankEvaluation) rather than
// re-implementing Recall@K / NDCG / MRR: a single hybrid run yields both the
// hybrid-RRF (pre-rerank `baseline`) and hybrid+rerank (`reranked`) arms, and the
// dense/sparse arms come from RAG_RETRIEVAL_ROUTE-forced runs reading `baseline`.
// Refusal accuracy (which needs abstain cases and the full QA path) is measured
// separately by shelling out to run-synthetic-eval on an abstain-bearing corpus,
// per arm, and reading its abstainAccuracy.
//
// HONESTY CONTRACT (enforced by labeling, not by hiding):
//   * Every report names its embedding provider. `deterministic` (default) is a
//     hashed term-frequency stand-in: reproducible, unbilled, non-semantic.
//     `openai` sends the corpus to the configured OpenAI-compatible endpoint,
//     which a paid API bills. Token/cost figures are list-price ESTIMATES
//     computed from text length (~4 chars/token), never measured spend.
//   * Latency is in-process wall time for search + fusion + rerank. The
//     query-embedding call runs before the timer, so it is excluded in both
//     modes. It is a RELATIVE cost signal across arms, not a production SLA.
//   * Arm differences carry a paired bootstrap 95% CI; a delta whose interval
//     includes zero is not a demonstrated difference on this many cases.
//   * RRF fusion scores, in-candidate-set normalized scores, and engineering
//     thresholds are never described as calibrated probabilities.
//   * When the git worktree is dirty the report is stamped previewOnly:true with a
//     banner; it is NOT valid same-SHA evidence until regenerated at a clean commit.
//
// Usage:
//   node evaluation/run-retrieval-comparison.mjs
//     [--embedding-provider deterministic|openai]   default: deterministic
//     [--rerank-provider heuristic|cross-encoder]   default: heuristic
//     [--cross-encoder-endpoint <url>] [--cross-encoder-model <name>]
//     [--corpus <path>]            default: corpora/arxiv-computer-science-rerank-v1.json
//     [--abstain-corpus <path>]    default: synthetic-corpus-near-duplicate.json
//     [--latest-name <name>]       default: latest-retrieval-comparison, suffixed with
//                                  -openai / -cross-encoder for non-default providers
//     [--top-k <n>] [--top-k-per-doc <n>] [--candidate-multiplier <n>]
//     [--no-refusal]               skip the synthetic-eval refusal pass (with
//                                  --embedding-provider openai it also calls the chat model)
//     [--splits heldout,tuning,full]  which splits to run (default all three)

import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { getEmbeddingModel } from "../rag/config.js";
import { MODEL_ROUTE_IDS } from "../rag/model-providers/schema.js";
import { runRerankEvaluation } from "./run-rerank-eval.mjs";
import { validateLatestName } from "./eval-cli.js";
import {
  attachEvaluationEvidence,
  getCorpusIdentity,
  resolveEvaluationProfile,
  toRepoRelativePath,
} from "./eval-evidence.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");
const generatedDirectory = path.join(__dirname, "generated");
const defaultCorpusPath = path.join(
  __dirname,
  "corpora",
  "arxiv-computer-science-rerank-v1.json"
);
const defaultAbstainCorpusPath = path.join(
  __dirname,
  "synthetic-corpus-near-duplicate.json"
);

// --- Split definition ------------------------------------------------------------
// Partition of the 8 arXiv papers into two disjoint sides. The partition (a) keeps
// each two-document `compare` case wholly on one side, and (b) groups the most
// closely related papers together so their relatedness cannot leak across the
// split: {rag, self_rag} both land in tuning, {dpr, colbert} both in held-out.
// A case belongs to a split iff ALL of its docKeys are in that split's doc set;
// because the compare pairs are within-side, every case lands in exactly one split.
const SPLIT_DOCS = {
  heldout: [
    "dense_passage_retrieval",
    "colbert_late_interaction",
    "react_reasoning_acting",
    "toolformer_self_supervised_tools",
  ],
  tuning: [
    "rag_knowledge_intensive_nlp",
    "self_rag_self_reflection",
    "hnsw_approximate_nearest_neighbor",
    "attention_is_all_you_need",
  ],
};

// The four comparison arms. `read` selects which metric block of the underlying
// run to report; `route` is the forced RAG_RETRIEVAL_ROUTE; `rerank` marks whether
// the arm's numbers come from the post-rerank block.
const ARMS = [
  { id: "dense", label: "dense-only", route: "dense", read: "baseline", rerank: false },
  { id: "sparse", label: "sparse-only (BM25)", route: "sparse", read: "baseline", rerank: false },
  { id: "hybrid_rrf", label: "hybrid RRF", route: "hybrid", read: "baseline", rerank: false },
  { id: "hybrid_rerank", label: "hybrid + rerank", route: "hybrid", read: "reranked", rerank: true },
];

// Which underlying route-run each arm reads from (dense/sparse have their own run;
// both hybrid arms share the single hybrid run).
const ROUTE_RUNS = ["dense", "sparse", "hybrid"];

// Paired comparisons reported with a bootstrap CI: fusion against each single
// route, rerank against the fusion it sits on, and the full default path against
// each single route.
const PAIRED_COMPARISONS = [
  { candidate: "hybrid_rrf", reference: "dense" },
  { candidate: "hybrid_rrf", reference: "sparse" },
  { candidate: "hybrid_rerank", reference: "hybrid_rrf" },
  { candidate: "hybrid_rerank", reference: "dense" },
  { candidate: "hybrid_rerank", reference: "sparse" },
];
const DELTA_METRICS = ["recallAtK", "ndcgAtK"];
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 1729;

// --- Providers and labeled cost assumptions (NOT measured; see honesty contract) --
const EMBEDDING_PROVIDERS = ["deterministic", "openai"];
const RERANK_PROVIDERS = ["heuristic", "cross-encoder"];
const DEFAULT_LATEST_NAME = "latest-retrieval-comparison";
const CHARS_PER_TOKEN = 4;
// OpenAI list prices in USD per 1M input tokens. A model outside this table (e.g. a
// local Ollama embedder) gets no price rather than a guessed one.
const EMBEDDING_LIST_PRICES = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.1,
};
// A deterministic run is priced as the default deployment it stands in for.
const DETERMINISTIC_PRICE_BASIS = "text-embedding-3-small";

const hasValue = (value) => String(value ?? "").trim() !== "";

const toChoice = (value, fallbackValue, allowedValues, optionName) => {
  const choice = value === undefined ? fallbackValue : String(value).trim().toLowerCase();
  if (!allowedValues.includes(choice)) {
    throw new Error(`${optionName} must be one of: ${allowedValues.join(", ")}.`);
  }
  return choice;
};

const resolveComparisonOptions = (args = {}, env = process.env) => {
  const embeddingProvider = toChoice(
    args["embedding-provider"],
    "deterministic",
    EMBEDDING_PROVIDERS,
    "--embedding-provider"
  );
  const rerankProvider = toChoice(
    args["rerank-provider"],
    "heuristic",
    RERANK_PROVIDERS,
    "--rerank-provider"
  );
  const crossEncoderEndpoint = args["cross-encoder-endpoint"] ?? env.RAG_CROSS_ENCODER_ENDPOINT;

  // Fail before anything is embedded, not halfway through a billed run.
  if (embeddingProvider === "openai" && !hasValue(env.OPENAI_API_KEY)) {
    throw new Error(
      "--embedding-provider openai needs OPENAI_API_KEY. For a keyless OpenAI-compatible endpoint set via OPENAI_BASE_URL (e.g. Ollama), any non-empty value works."
    );
  }
  if (rerankProvider === "cross-encoder" && !hasValue(crossEncoderEndpoint)) {
    throw new Error(
      "--rerank-provider cross-encoder needs --cross-encoder-endpoint or RAG_CROSS_ENCODER_ENDPOINT."
    );
  }

  // Non-default providers get their own report name, so a billed or neural run
  // never overwrites the reproducible deterministic evidence.
  const defaultName = [
    DEFAULT_LATEST_NAME,
    embeddingProvider === "openai" ? "openai" : null,
    rerankProvider === "cross-encoder" ? "cross-encoder" : null,
  ]
    .filter(Boolean)
    .join("-");

  return {
    embeddingProvider,
    rerankProvider,
    crossEncoderEndpoint: rerankProvider === "cross-encoder" ? crossEncoderEndpoint : undefined,
    crossEncoderModel: rerankProvider === "cross-encoder" ? args["cross-encoder-model"] : undefined,
    // The refusal pass runs the full QA path, so it follows the embedding provider:
    // a real-embedding comparison also answers with the real chat model.
    refusalProvider: embeddingProvider === "openai" ? "real" : "deterministic",
    latestName: validateLatestName(args["latest-name"], {
      defaultName,
      optionName: "--latest-name",
    }),
  };
};

// Host only: never the path, query string, or any credentials embedded in the URL.
const getEndpointHost = (rawUrl, fallbackHost) => {
  if (!hasValue(rawUrl)) return fallbackHost;
  try {
    return new URL(rawUrl).host;
  } catch {
    return "unparseable-endpoint";
  }
};

const describeProviders = (
  options,
  { env = process.env, embeddingName = getEmbeddingModel() } = {}
) => {
  const real = options.embeddingProvider === "openai";
  const priceBasis = real ? embeddingName : DETERMINISTIC_PRICE_BASIS;
  const crossEncoder = options.rerankProvider === "cross-encoder";
  return {
    mode: real ? "real" : "deterministic",
    embedding: {
      provider: options.embeddingProvider,
      name: real ? embeddingName : "deterministic hashed term-frequency",
      endpointHost: real
        ? getEndpointHost(env.OPENAI_BASE_URL || env.OPENAI_API_BASE, "api.openai.com")
        : null,
      callsEndpoint: real,
    },
    rerank: {
      provider: options.rerankProvider,
      name: crossEncoder
        ? options.crossEncoderModel ?? env.RAG_CROSS_ENCODER_MODEL ?? null
        : "heuristic lexical",
      endpointHost: crossEncoder ? getEndpointHost(options.crossEncoderEndpoint, null) : null,
    },
    refusalProvider: options.refusalProvider,
    cost: {
      charsPerToken: CHARS_PER_TOKEN,
      embeddingModel: priceBasis,
      embeddingUsdPerMillionTokens: EMBEDDING_LIST_PRICES[priceBasis] ?? null,
      note: real
        ? `List-price estimate for ${priceBasis}; this run calls the embedding endpoint, which a paid API bills. A null price means no list price is known for this model.`
        : "List-price estimate for the equivalent real-model deployment; the deterministic run in this report is not billed.",
    },
  };
};

const getArmLabel = (arm, providers) =>
  arm.rerank && providers.rerank.provider === "cross-encoder"
    ? `${arm.label} (cross-encoder)`
    : arm.label;

// --- small helpers ---------------------------------------------------------------
const parseArgs = (argv) => {
  const args = { splits: null, refusal: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--no-refusal") { args.refusal = false; continue; }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (key === "splits") { args.splits = String(value).split(",").map((s) => s.trim()).filter(Boolean); i += 1; continue; }
    args[key] = value;
    i += 1;
  }
  return args;
};

const round = (value, digits = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const mean = (values) => {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  return round(nums.reduce((a, b) => a + b, 0) / nums.length);
};

// Linear-interpolation (type-7) percentile over a numeric sample.
const percentile = (values, p) => {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (nums.length === 1) return round(nums[0], 2);
  const rank = (p / 100) * (nums.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return round(nums[lo], 2);
  const frac = rank - lo;
  return round(nums[lo] * (1 - frac) + nums[hi] * frac, 2);
};

const estimateTokens = (text) => Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);

const usdForEmbeddingTokens = (tokens, cost) =>
  Number.isFinite(cost.embeddingUsdPerMillionTokens)
    ? round((tokens / 1_000_000) * cost.embeddingUsdPerMillionTokens, 6)
    : null;

// mulberry32: a tiny seeded PRNG, so identical per-case metrics always produce the
// identical interval and a deterministic report stays reproducible.
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

// Paired percentile bootstrap over per-case differences (candidate - reference).
// Pairing matters: both arms answer the same cases, so resampling the differences
// removes the case-difficulty variance an unpaired interval would carry.
const pairedBootstrapDelta = (
  reference,
  candidate,
  { resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED, confidence = 0.95 } = {}
) => {
  const deltas = [];
  for (let i = 0; i < Math.min(reference.length, candidate.length); i += 1) {
    if (Number.isFinite(reference[i]) && Number.isFinite(candidate[i])) {
      deltas.push(candidate[i] - reference[i]);
    }
  }
  if (deltas.length === 0) return null;

  const random = createSeededRandom(seed);
  const resampledMeans = new Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i += 1) {
      sum += deltas[Math.floor(random() * deltas.length)];
    }
    resampledMeans[r] = sum / deltas.length;
  }
  resampledMeans.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const quantile = (q) =>
    resampledMeans[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))];
  const low = quantile(tail);
  const high = quantile(1 - tail);

  return {
    delta: round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length),
    ciLow: round(low),
    ciHigh: round(high),
    // Judged on the unrounded bounds, so rounding can never manufacture a result.
    excludesZero: low > 0 || high < 0,
    confidence,
    resamples,
    caseCount: deltas.length,
  };
};

const caseDocKeys = (testCase) =>
  testCase.docKeys ?? (testCase.docKey ? [testCase.docKey] : []);

const buildSplitCorpus = (corpus, docKeys) => {
  const docSet = new Set(docKeys);
  const documents = corpus.documents.filter((doc) => docSet.has(doc.key));
  const cases = (corpus.cases ?? []).filter((testCase) => {
    const keys = caseDocKeys(testCase);
    return keys.length > 0 && keys.every((key) => docSet.has(key));
  });
  return { ...corpus, documents, cases };
};

// --- env scoping so route/rerank overrides never leak across runs ----------------
const RUN_ENV_KEYS = [
  "RAG_RETRIEVAL_ROUTE",
  "VECTOR_STORE_PROVIDER",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_RRF_K",
  "RAG_RERANK_ENABLED",
  "RAG_RERANK_PROVIDER",
  "RAG_CROSS_ENCODER_ENDPOINT",
  "RAG_CROSS_ENCODER_MODEL",
];

const snapshotEnv = (keys) => Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const restoreEnv = (snapshot) => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

// --- one route-run of the IR-metrics harness on a split corpus -------------------
const runRouteRun = async ({ splitName, corpusFile, route, topK, options }) => {
  const latestName = `__cmp_${splitName}_${route}`;
  process.env.RAG_RETRIEVAL_ROUTE = route;
  process.env.VECTOR_STORE_PROVIDER = "local";
  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_HYBRID_FUSION = "rrf";
  process.env.RAG_RRF_K = process.env.RAG_RRF_K || "60";

  const result = await runRerankEvaluation({
    corpusPath: corpusFile,
    latestName,
    topK,
    embeddingProvider: options.embeddingProvider,
    rerankProvider: options.rerankProvider,
    crossEncoderEndpoint: options.crossEncoderEndpoint,
    crossEncoderModel: options.crossEncoderModel,
  });

  // The full per-case block lives only in the written report file.
  const report = JSON.parse(await readFile(result.latestJsonPath, "utf8"));
  return {
    metrics: report.summary.metrics,
    cases: report.cases ?? [],
    config: report.summary.config,
  };
};

// --- assemble arm rows for one split ---------------------------------------------
const buildSplitResult = async ({ splitName, corpus, docKeys, topK, options, providers }) => {
  const splitCorpus = buildSplitCorpus(corpus, docKeys);
  const corpusFile = path.join(
    generatedDirectory,
    "comparison-tmp",
    `${splitName}.json`
  );
  await mkdir(path.dirname(corpusFile), { recursive: true });
  await writeFile(corpusFile, JSON.stringify(splitCorpus, null, 2), "utf8");

  // One run per route; both hybrid arms share the hybrid run.
  const runs = {};
  for (const route of ROUTE_RUNS) {
    runs[route] = await runRouteRun({ splitName, corpusFile, route, topK, options });
  }
  // The rerank harness reads its own configured Top-K; record what it actually used.
  const effectiveConfig = runs.hybrid.config ?? {};

  // Token/cost estimate inputs for this split (shared corpus + queries).
  const ingestChars = splitCorpus.documents.reduce(
    (sum, doc) => sum + (doc.pages ?? []).reduce((acc, page) => acc + String(page).length, 0),
    0
  );
  const ingestEmbeddingTokens = Math.ceil(ingestChars / CHARS_PER_TOKEN);
  const queryEmbeddingTokens = splitCorpus.cases.reduce(
    (sum, testCase) => sum + estimateTokens(testCase.question),
    0
  );
  // What THIS run sends to the embedding API, as opposed to the per-arm deployment
  // estimate below: every route run re-ingests the split and embeds every question,
  // including the sparse run, whose query vector the harness computes but ignores.
  const runEmbeddingTokens = providers.embedding.callsEndpoint
    ? ROUTE_RUNS.length * (ingestEmbeddingTokens + queryEmbeddingTokens)
    : 0;

  const perCaseByArm = Object.fromEntries(
    ARMS.map((arm) => {
      const run = arm.route === "hybrid" ? runs.hybrid : runs[arm.route];
      const field = arm.rerank ? "rerankedMetrics" : "baselineMetrics";
      return [arm.id, new Map(run.cases.map((c) => [c.id, c[field] ?? {}]))];
    })
  );
  const pairedDeltas = PAIRED_COMPARISONS.map(({ candidate, reference }) => {
    const candidateCases = perCaseByArm[candidate];
    const referenceCases = perCaseByArm[reference];
    const caseIds = [...candidateCases.keys()].filter((id) => referenceCases.has(id));
    return {
      candidate,
      reference,
      ...Object.fromEntries(
        DELTA_METRICS.map((metric) => [
          metric,
          pairedBootstrapDelta(
            caseIds.map((id) => Number(referenceCases.get(id)[metric])),
            caseIds.map((id) => Number(candidateCases.get(id)[metric]))
          ),
        ])
      ),
    };
  });

  const arms = ARMS.map((arm) => {
    const run = arm.route === "hybrid" ? runs.hybrid : runs[arm.route];
    const metricsBlock = run.metrics[arm.read]; // baseline | reranked
    const perCaseMetricField = arm.rerank ? "rerankedMetrics" : "baselineMetrics";

    const latencies = run.cases.map((c) => c.responseTimeMs);
    const supported = run.cases.filter(
      (c) => Number((c[perCaseMetricField] ?? {}).recallAtK) > 0
    ).length;

    // Query-side embedding tokens: dense/hybrid embed the query; pure sparse does not.
    const usesQueryEmbedding = arm.route !== "sparse";
    const armQueryTokens = usesQueryEmbedding ? queryEmbeddingTokens : 0;
    // Ingestion embeddings are needed to populate the vector column (dense/hybrid);
    // a pure sparse (FTS-only) deployment would not embed at ingest.
    const armIngestTokens = usesQueryEmbedding ? ingestEmbeddingTokens : 0;
    const armEmbeddingTokens = armIngestTokens + armQueryTokens;

    return {
      id: arm.id,
      label: getArmLabel(arm, providers),
      recallAtK: metricsBlock.recallAtK,
      ndcgAtK: metricsBlock.ndcgAtK,
      mrr: metricsBlock.mrr,
      precisionAtK: metricsBlock.precisionAtK,
      noiseRateAtK: metricsBlock.noiseRateAtK,
      citationSupportRate: run.cases.length > 0 ? round(supported / run.cases.length) : null,
      caseCount: run.cases.length,
      latency: {
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        meanMs: mean(latencies),
        rerankIncluded: true,
      },
      estimatedCost: {
        embeddingTokens: armEmbeddingTokens,
        ingestEmbeddingTokens: armIngestTokens,
        queryEmbeddingTokens: armQueryTokens,
        embeddingUsd: usdForEmbeddingTokens(armEmbeddingTokens, providers.cost),
        rerankTokens: !arm.rerank
          ? 0
          : providers.rerank.provider === "cross-encoder"
            ? "n/a (cross-encoder endpoint; not token-billed here)"
            : "n/a (heuristic reranker; no API tokens)",
      },
    };
  });

  return {
    split: splitName,
    documentKeys: docKeys,
    documentCount: splitCorpus.documents.length,
    caseCount: splitCorpus.cases.length,
    topK: effectiveConfig.topK ?? topK,
    topKPerDoc: effectiveConfig.topKPerDoc ?? null,
    arms,
    pairedDeltas,
    runEmbeddingEstimate: {
      tokens: runEmbeddingTokens,
      usd: usdForEmbeddingTokens(runEmbeddingTokens, providers.cost),
    },
  };
};

// --- refusal accuracy via run-synthetic-eval (per arm, abstain corpus) -----------
// The full QA path (run-synthetic-eval) refuses to write a report whose executed
// routes contradict the DECLARED architecture: when RAG_HYBRID_ENABLED=true it
// requires BOTH routes to run for every case. So a single-route arm must also
// declare hybrid disabled. The route dispatcher checks RAG_RETRIEVAL_ROUTE before
// the hybrid flag, so retrieval still runs single-route — only the declared label
// changes, keeping the report's architecture evidence honest.
const REFUSAL_ARMS = [
  { id: "dense", route: "dense", hybridEnabled: false, rerank: false },
  { id: "sparse", route: "sparse", hybridEnabled: false, rerank: false },
  { id: "hybrid_rrf", route: "hybrid", hybridEnabled: true, rerank: false },
  { id: "hybrid_rerank", route: "hybrid", hybridEnabled: true, rerank: true },
];

const runRefusalPass = async ({ abstainCorpusPath, options }) => {
  const results = [];
  for (const arm of REFUSAL_ARMS) {
    const latestName = `__cmp_refusal_${arm.id}`;
    const latestJsonPath = path.join(resultsDirectory, `${latestName}.json`);
    const latestMarkdownPath = path.join(resultsDirectory, `${latestName}.md`);
    try {
      await execFileAsync(
        process.execPath,
        [
          path.join(__dirname, "run-synthetic-eval.mjs"),
          abstainCorpusPath,
          "--openai-provider",
          options.refusalProvider,
          "--latest-name",
          latestName,
        ],
        {
          cwd: path.join(__dirname, ".."),
          env: {
            ...process.env,
            RAG_RETRIEVAL_ROUTE: arm.route,
            VECTOR_STORE_PROVIDER: "local",
            RAG_HYBRID_ENABLED: arm.hybridEnabled ? "true" : "false",
            RAG_HYBRID_FUSION: "rrf",
            RAG_RRF_K: process.env.RAG_RRF_K || "60",
            RAG_RERANK_ENABLED: arm.rerank ? "true" : "false",
            // Same reranker as the ranking arms, never whatever the shell inherited.
            RAG_RERANK_PROVIDER: options.rerankProvider,
            ...(options.crossEncoderEndpoint
              ? { RAG_CROSS_ENCODER_ENDPOINT: options.crossEncoderEndpoint }
              : {}),
            ...(options.crossEncoderModel
              ? { RAG_CROSS_ENCODER_MODEL: options.crossEncoderModel }
              : {}),
          },
          maxBuffer: 64 * 1024 * 1024,
        }
      );
      const report = JSON.parse(await readFile(latestJsonPath, "utf8"));
      results.push({
        id: arm.id,
        abstainAccuracy: report.summary?.metrics?.abstainAccuracy ?? null,
        overallPassRate: report.summary?.metrics?.overallPassRate ?? null,
        claimSupportHitRate: report.summary?.metrics?.claimSupportHitRate ?? null,
      });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim();
      results.push({ id: arm.id, abstainAccuracy: null, error: detail.slice(-400) });
    }
  }
  return results;
};

// --- markdown rendering ----------------------------------------------------------
const fmt = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? "N/A"
    : Number(value).toFixed(digits);

const renderSplitTable = (splitResult) => {
  const lines = [
    `### Split: \`${splitResult.split}\` — ${splitResult.documentCount} docs, ${splitResult.caseCount} cases (Top-K=${splitResult.topK})`,
    "",
    `Documents: ${splitResult.documentKeys.map((k) => `\`${k}\``).join(", ")}`,
    "",
    "| Arm | Recall@K | NDCG@K | MRR | Precision@K | Noise@K | Citation-support | p50 ms | p95 ms | Est. embed tokens | Est. embed USD |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of splitResult.arms) {
    lines.push(
      `| ${arm.label} | ${fmt(arm.recallAtK)} | ${fmt(arm.ndcgAtK)} | ${fmt(arm.mrr)} | ${fmt(arm.precisionAtK)} | ${fmt(arm.noiseRateAtK)} | ${fmt(arm.citationSupportRate)} | ${fmt(arm.latency.p50Ms, 1)} | ${fmt(arm.latency.p95Ms, 1)} | ${arm.estimatedCost.embeddingTokens} | ${arm.estimatedCost.embeddingUsd ?? "N/A"} |`
    );
  }
  lines.push("");
  if (splitResult.pairedDeltas?.length) {
    lines.push(renderPairedDeltaTable(splitResult));
  }
  return lines.join("\n");
};

const fmtSigned = (value) => {
  if (!Number.isFinite(Number(value))) return "N/A";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(4)}`;
};

const fmtDelta = (entry) => {
  if (!entry) return "N/A";
  const delta = entry.excludesZero ? `**${fmtSigned(entry.delta)}**` : fmtSigned(entry.delta);
  return `${delta} [${fmtSigned(entry.ciLow)}, ${fmtSigned(entry.ciHigh)}]`;
};

const renderPairedDeltaTable = (splitResult) => {
  const labelById = Object.fromEntries(splitResult.arms.map((arm) => [arm.id, arm.label]));
  const lines = [
    `Paired deltas (candidate − reference, same ${splitResult.caseCount} cases, 95% bootstrap CI). **Bold** = the interval excludes 0; otherwise the difference is not demonstrated on this many cases.`,
    "",
    "| Comparison | ΔRecall@K [95% CI] | ΔNDCG@K [95% CI] |",
    "|---|---|---|",
  ];
  for (const entry of splitResult.pairedDeltas) {
    lines.push(
      `| ${labelById[entry.candidate] ?? entry.candidate} − ${labelById[entry.reference] ?? entry.reference} | ${fmtDelta(entry.recallAtK)} | ${fmtDelta(entry.ndcgAtK)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
};

const renderRefusalTable = (refusal, providers) => {
  if (!refusal) return "_Refusal pass skipped (`--no-refusal`)._";
  const lines = [
    "| Arm | Abstain accuracy | Overall pass rate | Claim-support hit |",
    "|---|---|---|---|",
  ];
  const labelById = Object.fromEntries(ARMS.map((a) => [a.id, getArmLabel(a, providers)]));
  for (const row of refusal) {
    if (row.error) {
      lines.push(`| ${labelById[row.id] ?? row.id} | N/A (run failed) | — | — |`);
    } else {
      lines.push(
        `| ${labelById[row.id] ?? row.id} | ${fmt(row.abstainAccuracy)} | ${fmt(row.overallPassRate)} | ${fmt(row.claimSupportHitRate)} |`
      );
    }
  }
  return lines.join("\n");
};

const DETERMINISTIC_INTERPRETATION = [
  "## Interpreting these numbers (deterministic provider — read before quoting)",
  "The `deterministic` embedding is a **hashed term-frequency vector** (`toDeterministicEmbedding`: each term is hashed to a bucket and counted). It is lexical and reproducible, but **non-semantic** and carries hash-collision noise. Consequences that are EXPECTED, not defects:",
  "- The **dense** arm here is crude TF-cosine, so the **sparse (BM25)** arm — which adds IDF weighting, term saturation, and length normalization — usually ranks it. A dense arm leading sparse is a **real-embedding** phenomenon and is not exercised here.",
  "- **Hybrid RRF can fall BELOW the stronger single arm.** RRF gives each input list an equal per-rank vote; fusing a strong BM25 list with a noisy hashed-TF list lets collision-driven disagreements displace good BM25 hits from the final Top-K. This is standard rank-fusion dilution when one input is weak, not a fusion bug (the arms are genuinely distinct — verified by `retrieval-route-selection.test.mjs`).",
  "- The **reranker** can partially repair fusion damage here (hybrid+rerank vs hybrid RRF). Check the paired-delta table before reading that as a gain, and note it says nothing about rerank under real embeddings.",
  "",
  "**Boundary:** these figures validate that the four arms are wired correctly, scored with separated signals, and behave sensibly *relative to each other under a non-semantic embedding*. They are **NOT** evidence about production semantic quality or that hybrid beats sparse in deployment. That claim requires a **real-embedding** run (`--embedding-provider openai`; billed, so not generated by default). Do not quote a deterministic arm ordering as a production result.",
];

const buildRealInterpretation = (providers) => [
  "## Interpreting these numbers (real embeddings — read before quoting)",
  `Dense vectors come from \`${providers.embedding.name}\`, so unlike the deterministic report the dense and hybrid arms here reflect semantic retrieval. Limits to state alongside any number quoted from this report:`,
  "- **Small corpus.** Each split has a few dozen cases. Quote an arm difference only when the paired-delta table shows its 95% CI excluding 0.",
  "- **The sparse arm is BM25 on the local backend.** A pgvector deployment's sparse route is PostgreSQL `ts_rank_cd` FTS, so the sparse and hybrid rows are not a measurement of the pgvector sparse route.",
  providers.rerank.provider === "cross-encoder"
    ? "- **Rerank is a cross-encoder** served by the endpoint named in the header; its latency is inside the timed path."
    : "- **Rerank is the heuristic lexical reranker**, not a neural cross-encoder. Run with `--rerank-provider cross-encoder` to measure one.",
  "- **Latency excludes the query-embedding API call**, which usually dominates retrieval time against a remote endpoint. The p50/p95 columns compare arms; they are not an SLA.",
  "",
  "**Boundary:** retrieval ranking quality on this corpus only — not answer faithfulness (see `npm run verify:quality`) and not end-to-end latency.",
];

const SPLIT_METHODOLOGY =
  "Tuning and held-out are split **by source document**; no document appears on both sides, the two most-related paper pairs are kept together within a side, and every multi-document `compare` case stays wholly on one side. The four arms are **fixed configurations** (no per-split hyperparameter fitting), so the split guards against corpus-specific cherry-picking.";
const SPLIT_ORDERING_DETERMINISTIC =
  "On a corpus this small under a **non-semantic** deterministic embedding the **arm ordering can differ between the two disjoint sets** (it is *not* asserted to be stable — e.g. sparse leads the held-out split while hybrid+rerank leads the tuning split), which is exactly why **held-out is the primary generalization figure** and why a production-representative ordering requires a real-embedding run.";
const SPLIT_ORDERING_REAL =
  "**Held-out is the primary generalization figure.** If the arm ordering differs between the two disjoint sets, treat the ordering as unsettled on this corpus rather than picking the split that reads better.";

const describeRerank = (providers) =>
  providers.rerank.provider === "cross-encoder"
    ? `cross-encoder \`${providers.rerank.name ?? "model not named"}\` via \`${providers.rerank.endpointHost}\``
    : "heuristic lexical reranker (not a neural cross-encoder)";

const formatUsd = (usd) => (Number.isFinite(usd) ? `$${usd}` : "N/A (no list price)");

const buildMarkdown = ({ report }) => {
  const ev = report.evidence ?? {};
  const providers = report.providers;
  const real = providers.mode === "real";
  const cost = providers.cost;
  const priceText = Number.isFinite(cost.embeddingUsdPerMillionTokens)
    ? `$${cost.embeddingUsdPerMillionTokens}/1M tokens for ${cost.embeddingModel}`
    : `no list price known for ${cost.embeddingModel}, so USD is N/A`;
  const banner = report.previewOnly
    ? [
        "> ⚠️ **PREVIEW — NOT valid same-SHA evidence.**",
        `> Generated on a **dirty** git worktree (commit \`${ev.git?.commitSha ?? "unknown"}\`, dirty=${ev.git?.dirty}).`,
        "> Regenerate at a clean commit before citing any number here as current evidence.",
        "",
      ].join("\n")
    : "";
  const lines = [
    "# Retrieval Arm Comparison (dense / sparse / hybrid RRF / hybrid + rerank)",
    "",
    banner,
    `- Run ID: \`${report.runId}\``,
    `- Generated: ${report.generatedAt}`,
    `- Commit: \`${ev.git?.commitSha ?? "unknown"}\` · worktree dirty: **${ev.git?.dirty}**`,
    `- Corpus: \`${report.corpus.relativePath}\` (hash \`${ev.corpus?.contentHash ?? "unknown"}\`)`,
    `- Abstain corpus (refusal pass): \`${report.abstainCorpus?.relativePath ?? "n/a"}\``,
    real
      ? `- Provider: **real** embeddings — \`${providers.embedding.name}\` via \`${providers.embedding.endpointHost}\`. This run calls the embedding endpoint: ≈ ${report.runEmbeddingEstimate?.tokens ?? "?"} tokens, ${formatUsd(report.runEmbeddingEstimate?.usd)} at list price${providers.refusalProvider === "real" && report.refusal ? ", plus the refusal pass's chat calls (not estimated)" : ""}.`
      : `- Provider: **deterministic** embedding + answer provider (labeled) — model-equivalent \`${cost.embeddingModel}\` for cost estimates`,
    `- Rerank: ${describeRerank(providers)}`,
    `- Sparse backend on this run: **BM25** (local backend). Note: on a pgvector deployment the sparse route is PostgreSQL \`ts_rank_cd\` FTS, not BM25.`,
    "",
    "## What each column means (and what it is NOT)",
    "- **Recall@K / NDCG@K / MRR / Precision@K / Noise@K**: standard IR ranking metrics on the final Top-K, graded against per-case expected evidence units.",
    "- **Citation-support**: share of answerable cases with ≥1 relevant unit in the final Top-K (a retrieval-level support proxy, not an answer-faithfulness score).",
    "- **p50/p95 ms**: in-process wall time per case for search + fusion + rerank (the rerank stage runs in every arm's timed path; the query-embedding call runs before the timer and is excluded) — a RELATIVE cost signal measured identically across arms, **not a production SLA**.",
    real
      ? `- **Est. embed tokens / USD**: list-price ESTIMATE (~${cost.charsPerToken} chars/token, ${priceText}) of what an equivalent deployment embeds for this split: ingest plus queries, and nothing for sparse-only. Not measured spend; this run's own spend estimate is in the header.`
      : `- **Est. embed tokens / USD**: list-price ESTIMATE (~${cost.charsPerToken} chars/token, ${priceText}) for the equivalent real-model deployment. The deterministic run is billed $0. Not measured spend.`,
    "- None of these are calibrated probabilities. RRF fusion scores and in-set-normalized scores are ranking figures only.",
    "",
    ...(real ? buildRealInterpretation(providers) : DETERMINISTIC_INTERPRETATION),
    "",
    "## Split methodology",
    `${SPLIT_METHODOLOGY} ${real ? SPLIT_ORDERING_REAL : SPLIT_ORDERING_DETERMINISTIC}`,
    "",
    "## Ranking + latency + estimated-cost comparison",
    "",
  ];
  for (const splitResult of report.splits) {
    lines.push(renderSplitTable(splitResult));
  }
  lines.push("## Refusal accuracy (separate abstain-bearing corpus, full QA path)");
  lines.push("");
  lines.push(
    `Measured via \`run-synthetic-eval\` on \`${report.abstainCorpus?.relativePath ?? "n/a"}\` (${report.abstainCorpus?.abstainCases ?? "?"} abstain cases), per arm, ${providers.refusalProvider === "real" ? "real chat + embedding provider" : "deterministic provider"}. arXiv has 0 abstain cases, so refusal cannot be measured on the ranking corpus.`
  );
  lines.push("");
  lines.push(renderRefusalTable(report.refusal, providers));
  lines.push("");
  return lines.filter((l) => l !== undefined).join("\n");
};

// --- main ------------------------------------------------------------------------
const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const options = resolveComparisonOptions(args);
  const providers = describeProviders(options);
  const corpusPath = args.corpus ? path.resolve(process.cwd(), args.corpus) : defaultCorpusPath;
  const abstainCorpusPath = args["abstain-corpus"]
    ? path.resolve(process.cwd(), args["abstain-corpus"])
    : defaultAbstainCorpusPath;
  const { latestName } = options;
  const topK = Number(args["top-k"]) > 0 ? Number(args["top-k"]) : 5;
  const requestedSplits = args.splits ?? ["heldout", "tuning", "full"];

  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const allDocKeys = corpus.documents.map((d) => d.key);
  const splitDocKeys = {
    heldout: SPLIT_DOCS.heldout,
    tuning: SPLIT_DOCS.tuning,
    full: allDocKeys,
  };

  // Snapshot results/ so every intermediate report the child runs write there
  // (per-route rerank runs, per-arm synthetic runs, and their run-scoped copies)
  // can be swept afterward, leaving only the final comparison report behind.
  const resultsBefore = new Set(
    await readdir(resultsDirectory).catch(() => [])
  );
  const keep = new Set([`${latestName}.json`, `${latestName}.md`]);

  // Guaranteed cleanup, invoked from the `finally` below. Removes (a) every results/
  // file THIS run newly created (snapshot-diff, so a concurrent/unrelated eval
  // output is never touched) and (b) any file under this harness's private `__cmp_*`
  // prefix even if an earlier partial run orphaned it, so retries cannot accumulate.
  // Running in `finally` means a mid-run throw can never leave intermediates behind.
  // All of these are gitignored throwaway reports; the final comparison report
  // (protected by `keep`) is preserved.
  const sweepIntermediates = async () => {
    const after = await readdir(resultsDirectory).catch(() => []);
    await Promise.all(
      after
        .filter(
          (name) =>
            !keep.has(name) &&
            (!resultsBefore.has(name) || name.startsWith("__cmp_"))
        )
        .map((name) => rm(path.join(resultsDirectory, name), { force: true }).catch(() => {}))
    );
    await rm(path.join(generatedDirectory, "comparison-tmp"), { recursive: true, force: true }).catch(() => {});
  };

  try {
    const envSnapshot = snapshotEnv(RUN_ENV_KEYS);
    const splits = [];
    try {
      for (const splitName of requestedSplits) {
        const docKeys = splitDocKeys[splitName];
        if (!docKeys) throw new Error(`unknown split: ${splitName}`);
        const splitResult = await buildSplitResult({
          splitName,
          corpus,
          docKeys,
          topK,
          options,
          providers,
        });
        splits.push(splitResult);
      }
    } finally {
      restoreEnv(envSnapshot);
    }

  let refusal = null;
  let abstainMeta = null;
  if (args.refusal) {
    const refusalEnvSnapshot = snapshotEnv(RUN_ENV_KEYS);
    try {
      refusal = await runRefusalPass({ abstainCorpusPath, options });
    } finally {
      restoreEnv(refusalEnvSnapshot);
    }
    const abstainCorpus = JSON.parse(await readFile(abstainCorpusPath, "utf8"));
    abstainMeta = {
      relativePath: toRepoRelativePath(abstainCorpusPath),
      abstainCases: (abstainCorpus.cases ?? []).filter((c) => c.shouldAbstain).length,
    };
  }

  const runId = `cmp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const corpusIdentity = getCorpusIdentity({ corpus, corpusPath });
  const runEmbeddingTokens = splits.reduce((sum, s) => sum + s.runEmbeddingEstimate.tokens, 0);

  const baseReport = {
    runId,
    generatedAt: new Date().toISOString(),
    reportType: "retrieval-comparison",
    corpus: {
      id: corpusIdentity.id,
      relativePath: toRepoRelativePath(corpusPath),
      documents: corpus.documents.length,
      cases: (corpus.cases ?? []).length,
    },
    abstainCorpus: abstainMeta,
    provider: { id: "retrieval-comparison", mode: providers.mode },
    providers,
    providerNote:
      providers.mode === "real"
        ? `Real embeddings from ${providers.embedding.name}; arm ordering reflects semantic retrieval on this corpus only. Arm differences are quotable only where the paired bootstrap CI excludes 0. RRF/normalized scores are ranking figures, never calibrated probabilities.`
        : "Deterministic embedding is a hashed term-frequency (non-semantic) vector; arm ordering reflects lexical plumbing behavior, NOT production semantic quality. Real-embedding numbers need --embedding-provider openai and are not generated here. RRF/normalized scores are ranking figures, never calibrated probabilities.",
    costAssumptions: providers.cost,
    runEmbeddingEstimate: {
      tokens: runEmbeddingTokens,
      usd: usdForEmbeddingTokens(runEmbeddingTokens, providers.cost),
    },
    splitDocs: SPLIT_DOCS,
    splits,
    refusal,
  };

  const providerFlags = [
    options.embeddingProvider !== "deterministic" ? `--embedding-provider ${options.embeddingProvider}` : null,
    options.rerankProvider !== "heuristic" ? `--rerank-provider ${options.rerankProvider}` : null,
  ].filter(Boolean);
  const stamped = await attachEvaluationEvidence(baseReport, {
    command: ["npm run eval:retrieval-comparison", ...(providerFlags.length ? ["--", ...providerFlags] : [])].join(" "),
    corpus: { ...corpusIdentity, path: corpusPath },
    modelRouteId: providers.mode === "real" ? MODEL_ROUTE_IDS.embeddingDefault : null,
    profile: resolveEvaluationProfile("default"),
    provider: { id: "retrieval-comparison", mode: providers.mode },
    // Secret-safe keys only: the evidence sanitizer strips any field whose name
    // matches model/token/prompt/secret/etc., so names here avoid those substrings.
    publicConfig: {
      arms: ARMS.map((arm) => arm.id),
      routeRuns: ROUTE_RUNS,
      splits: requestedSplits,
      topK,
      fusion: "rrf",
      rrfK: Number(process.env.RAG_RRF_K || 60),
      sparseBackend: "bm25-local",
      providerMode: providers.mode,
      embeddingProvider: options.embeddingProvider,
      rerankProvider: options.rerankProvider,
      refusalProvider: options.refusalProvider,
      bootstrap: { resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED },
      charsPerUnit: CHARS_PER_TOKEN,
      embeddingUsdPerMillion: providers.cost.embeddingUsdPerMillionTokens,
    },
    reportId: `retrieval-comparison-${latestName}`,
    reportType: "retrieval-comparison",
    runId,
  });

  // A dirty worktree means this is not valid same-SHA evidence.
  stamped.previewOnly = stamped.evidence?.git?.dirty !== false;

  await mkdir(resultsDirectory, { recursive: true });
  const latestJsonPath = path.join(resultsDirectory, `${latestName}.json`);
  const latestMarkdownPath = path.join(resultsDirectory, `${latestName}.md`);
  await writeFile(latestJsonPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  await writeFile(latestMarkdownPath, `${buildMarkdown({ report: stamped })}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          latestJsonPath,
          latestMarkdownPath,
          previewOnly: stamped.previewOnly,
          providerMode: providers.mode,
          runEmbeddingEstimate: baseReport.runEmbeddingEstimate,
          commitSha: stamped.evidence?.git?.commitSha,
          dirty: stamped.evidence?.git?.dirty,
          splits: splits.map((s) => ({
            split: s.split,
            arms: s.arms.map((a) => ({ id: a.id, recallAtK: a.recallAtK, ndcgAtK: a.ndcgAtK, mrr: a.mrr })),
          })),
          refusal: refusal?.map((r) => ({ id: r.id, abstainAccuracy: r.abstainAccuracy })),
        },
        null,
        2
      )
    );
  } finally {
    await sweepIntermediates();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export {
  buildMarkdown,
  buildSplitCorpus,
  describeProviders,
  pairedBootstrapDelta,
  resolveComparisonOptions,
  SPLIT_DOCS,
  ARMS,
  percentile,
};
