// run-retrieval-comparison.mjs
//
// Req-4 effect-evaluation harness: compares the four retrieval arms
//   1. dense-only
//   2. sparse-only        (local backend => BM25 lexical ranking)
//   3. hybrid RRF         (dense + sparse fused by Reciprocal Rank Fusion)
//   4. hybrid + rerank    (hybrid RRF then heuristic cross-encoder-style rerank)
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
//   * Provider is the DETERMINISTIC embedding/answer provider — labeled as such.
//     A deterministic run is not billed; token/cost figures are list-price
//     ESTIMATES for the equivalent real-model deployment, computed from text
//     length (~4 chars/token). They are estimates, never measured spend.
//   * Latency is in-process, single-threaded wall time under deterministic
//     embeddings — a RELATIVE cost signal across arms measured identically, not a
//     production SLA.
//   * RRF fusion scores, in-candidate-set normalized scores, and engineering
//     thresholds are never described as calibrated probabilities.
//   * When the git worktree is dirty the report is stamped previewOnly:true with a
//     banner; it is NOT valid same-SHA evidence until regenerated at a clean commit.
//
// Usage:
//   node evaluation/run-retrieval-comparison.mjs
//     [--corpus <path>]            default: corpora/arxiv-computer-science-rerank-v1.json
//     [--abstain-corpus <path>]    default: synthetic-corpus-near-duplicate.json
//     [--latest-name <name>]       default: latest-retrieval-comparison
//     [--top-k <n>] [--top-k-per-doc <n>] [--candidate-multiplier <n>]
//     [--no-refusal]               skip the synthetic-eval refusal pass
//     [--splits heldout,tuning,full]  which splits to run (default all three)

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { runRerankEvaluation } from "./run-rerank-eval.mjs";
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

// --- Labeled cost assumptions (NOT measured; see honesty contract) ---------------
const COST_ASSUMPTIONS = {
  charsPerToken: 4,
  embeddingModel: "text-embedding-3-small",
  embeddingUsdPerMillionTokens: 0.02, // OpenAI list price, 2025; stated assumption.
  note: "List-price estimate for the equivalent real-model deployment; the deterministic run in this report is not billed.",
};

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

const estimateTokens = (text) =>
  Math.ceil(String(text ?? "").length / COST_ASSUMPTIONS.charsPerToken);

const usdForEmbeddingTokens = (tokens) =>
  round((tokens / 1_000_000) * COST_ASSUMPTIONS.embeddingUsdPerMillionTokens, 6);

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
];

const snapshotEnv = (keys) => Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const restoreEnv = (snapshot) => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

// --- one route-run of the IR-metrics harness on a split corpus -------------------
const runRouteRun = async ({ splitName, corpusFile, route, topK }) => {
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
    embeddingProvider: "deterministic",
    rerankProvider: "heuristic",
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
const buildSplitResult = async ({ splitName, corpus, docKeys, topK }) => {
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
    runs[route] = await runRouteRun({ splitName, corpusFile, route, topK });
  }
  // The rerank harness reads its own configured Top-K; record what it actually used.
  const effectiveConfig = runs.hybrid.config ?? {};

  // Token/cost estimate inputs for this split (shared corpus + queries).
  const ingestChars = splitCorpus.documents.reduce(
    (sum, doc) => sum + (doc.pages ?? []).reduce((acc, page) => acc + String(page).length, 0),
    0
  );
  const ingestEmbeddingTokens = Math.ceil(ingestChars / COST_ASSUMPTIONS.charsPerToken);
  const queryEmbeddingTokens = splitCorpus.cases.reduce(
    (sum, testCase) => sum + estimateTokens(testCase.question),
    0
  );

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
      label: arm.label,
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
        embeddingUsd: usdForEmbeddingTokens(armEmbeddingTokens),
        rerankTokens: arm.rerank ? "n/a (heuristic reranker; no API tokens)" : 0,
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

const runRefusalPass = async ({ abstainCorpusPath }) => {
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
          "deterministic",
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
      `| ${arm.label} | ${fmt(arm.recallAtK)} | ${fmt(arm.ndcgAtK)} | ${fmt(arm.mrr)} | ${fmt(arm.precisionAtK)} | ${fmt(arm.noiseRateAtK)} | ${fmt(arm.citationSupportRate)} | ${fmt(arm.latency.p50Ms, 1)} | ${fmt(arm.latency.p95Ms, 1)} | ${arm.estimatedCost.embeddingTokens} | ${arm.estimatedCost.embeddingUsd} |`
    );
  }
  lines.push("");
  return lines.join("\n");
};

const renderRefusalTable = (refusal) => {
  if (!refusal) return "_Refusal pass skipped (`--no-refusal`)._";
  const lines = [
    "| Arm | Abstain accuracy | Overall pass rate | Claim-support hit |",
    "|---|---|---|---|",
  ];
  const labelById = Object.fromEntries(ARMS.map((a) => [a.id, a.label]));
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

const buildMarkdown = ({ report }) => {
  const ev = report.evidence ?? {};
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
    `- Provider: **deterministic** embedding + answer provider (labeled) — model-equivalent \`${COST_ASSUMPTIONS.embeddingModel}\` for cost estimates`,
    `- Sparse backend on this run: **BM25** (local backend). Note: on a pgvector deployment the sparse route is PostgreSQL \`ts_rank_cd\` FTS, not BM25.`,
    "",
    "## What each column means (and what it is NOT)",
    "- **Recall@K / NDCG@K / MRR / Precision@K / Noise@K**: standard IR ranking metrics on the final Top-K, graded against per-case expected evidence units.",
    "- **Citation-support**: share of answerable cases with ≥1 relevant unit in the final Top-K (a retrieval-level support proxy, not an answer-faithfulness score).",
    "- **p50/p95 ms**: in-process wall time per case under deterministic embeddings with the (heuristic) rerank stage present in every arm — a RELATIVE cost signal measured identically across arms, **not a production SLA**.",
    "- **Est. embed tokens / USD**: list-price ESTIMATE (~4 chars/token, $%s/1M tokens for %s) for the equivalent real-model deployment. The deterministic run is billed $0. Not measured spend.".replace("%s/1M", `${COST_ASSUMPTIONS.embeddingUsdPerMillionTokens}/1M`).replace("%s", COST_ASSUMPTIONS.embeddingModel),
    "- None of these are calibrated probabilities. RRF fusion scores and in-set-normalized scores are ranking figures only.",
    "",
    "## Interpreting these numbers (deterministic provider — read before quoting)",
    "The `deterministic` embedding is a **hashed term-frequency vector** (`toDeterministicEmbedding`: each term is hashed to a bucket and counted). It is lexical and reproducible, but **non-semantic** and carries hash-collision noise. Consequences that are EXPECTED, not defects:",
    "- The **dense** arm here is crude TF-cosine, so the **sparse (BM25)** arm — which adds IDF weighting, term saturation, and length normalization — usually ranks it. A dense arm leading sparse is a **real-embedding** phenomenon and is not exercised here.",
    "- **Hybrid RRF can fall BELOW the stronger single arm.** RRF gives each input list an equal per-rank vote; fusing a strong BM25 list with a noisy hashed-TF list lets collision-driven disagreements displace good BM25 hits from the final Top-K. This is standard rank-fusion dilution when one input is weak, not a fusion bug (the arms are genuinely distinct — verified by `retrieval-route-selection.test.mjs`).",
    "- The **reranker** partially repairs fusion damage (hybrid+rerank ≥ hybrid RRF), which is why rerank stays in the default path.",
    "",
    "**Boundary:** these figures validate that the four arms are wired correctly, scored with separated signals, and behave sensibly *relative to each other under a non-semantic embedding*. They are **NOT** evidence about production semantic quality or that hybrid beats sparse in deployment. That claim requires a **real-embedding** run (credential-gated; not generated in this report). Do not quote a deterministic arm ordering as a production result.",
    "",
    "## Split methodology",
    "Tuning and held-out are split **by source document**; no document appears on both sides, the two most-related paper pairs are kept together within a side, and every multi-document `compare` case stays wholly on one side. The four arms are **fixed configurations** (no per-split hyperparameter fitting), so the split guards against corpus-specific cherry-picking. On a corpus this small under a **non-semantic** deterministic embedding the **arm ordering can differ between the two disjoint sets** (it is *not* asserted to be stable — e.g. sparse leads the held-out split while hybrid+rerank leads the tuning split), which is exactly why **held-out is the primary generalization figure** and why a production-representative ordering requires a real-embedding run.",
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
    `Measured via \`run-synthetic-eval\` on \`${report.abstainCorpus?.relativePath ?? "n/a"}\` (${report.abstainCorpus?.abstainCases ?? "?"} abstain cases), per arm, deterministic provider. arXiv has 0 abstain cases, so refusal cannot be measured on the ranking corpus.`
  );
  lines.push("");
  lines.push(renderRefusalTable(report.refusal));
  lines.push("");
  return lines.filter((l) => l !== undefined).join("\n");
};

// --- main ------------------------------------------------------------------------
const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = args.corpus ? path.resolve(process.cwd(), args.corpus) : defaultCorpusPath;
  const abstainCorpusPath = args["abstain-corpus"]
    ? path.resolve(process.cwd(), args["abstain-corpus"])
    : defaultAbstainCorpusPath;
  const latestName = args["latest-name"] ?? "latest-retrieval-comparison";
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
        const splitResult = await buildSplitResult({ splitName, corpus, docKeys, topK });
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
      refusal = await runRefusalPass({ abstainCorpusPath });
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
    provider: { id: "retrieval-comparison", mode: "deterministic" },
    providerNote:
      "Deterministic embedding is a hashed term-frequency (non-semantic) vector; arm ordering reflects lexical plumbing behavior, NOT production semantic quality. Real-embedding numbers are credential-gated and not generated here. RRF/normalized scores are ranking figures, never calibrated probabilities.",
    costAssumptions: COST_ASSUMPTIONS,
    splitDocs: SPLIT_DOCS,
    splits,
    refusal,
  };

  const stamped = await attachEvaluationEvidence(baseReport, {
    command: "npm run eval:retrieval-comparison",
    corpus: { ...corpusIdentity, path: corpusPath },
    profile: resolveEvaluationProfile("default"),
    provider: { id: "retrieval-comparison", mode: "deterministic" },
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
      providerMode: "deterministic",
      charsPerUnit: COST_ASSUMPTIONS.charsPerToken,
      embeddingUsdPerMillion: COST_ASSUMPTIONS.embeddingUsdPerMillionTokens,
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

export { buildSplitCorpus, SPLIT_DOCS, ARMS, percentile };
