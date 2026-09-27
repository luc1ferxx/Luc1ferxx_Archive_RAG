// run-sparse-scoring-eval.mjs
//
// ts_rank_cd against Okapi BM25, each exhaustive and with common-term pruning,
// on the route they actually run on: the pgvector sparse route, in a
// disposable PostgreSQL with the app's own migrations, ingest and retrieval
// code. The QASPER retrieval eval (run-qasper-retrieval-eval.mjs) runs the
// standalone profile, whose sparse route is the local in-memory BM25 store --
// not the route RAG_SPARSE_SCORING changes -- so this harness ingests the same
// sample into pgvector instead and measures, per answerable question, evidence
// recall of retrieveQaCandidates (the QA route up to its gate) with the hybrid
// route and with the sparse route alone (RAG_RETRIEVAL_ROUTE=sparse): hitAt1,
// hitAt3, hitAtAll (an annotated evidence paragraph of the question's paper
// among the candidates) and admitted (among the chunks the default gate
// admits), with paired bootstrap 95% CIs, in three regimes:
//
//   * single: the question's own paper, every paper in one pooled owner scope
//     (API auth off). A paper holds fewer chunks than
//     PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS, so both scorings run exhaustively here
//     whatever the pruning setting.
//   * global: every sampled paper as the document set (the global retriever
//     over the whole pooled scope), where pruning really runs; each scoring
//     exhaustive and pruned at --prune-fraction with the configured
//     common-term cap. Also, per question, the raw sparse route over all
//     papers: which candidate path pruning took (mixed query / every term
//     common / no common term), how often the pruned top-K differs from the
//     exhaustive one, and its latency (owner, no RLS); recall is reported per
//     path as well.
//   * tenant: every paper ingested a second time under its own owner scope
//     and retrieved as that tenant with row-level security enforced, so BM25's
//     statistics are that one paper's; paired against the pooled single arm.
//
// Nothing here calls a chat model. Embeddings come from the configured
// OpenAI-compatible endpoint (local Ollama in the documented runs).
//
// Database: --database-url names a DISPOSABLE database (its documents are
// cleared before and after). Without it the harness creates a throwaway
// cluster under $TMPDIR on an OS-assigned 127.0.0.1 port with initdb/pg_ctl
// (Postgres.app, PG_BIN_DIR or PATH) and deletes it on exit. It never reads
// server/.env: run it with DOTENV_CONFIG_PATH pointing at an empty file (the
// QASPER helpers it imports load dotenv).
//
// Usage:
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
//   node evaluation/run-sparse-scoring-eval.mjs
//     [--corpus evaluation/generated/qasper-train.json] [--cases 400] [--seed 1]
//     [--prune-fraction 0.1]            the pruned arms (RAG_SPARSE_PRUNE_DF_FRACTION)
//     [--no-tenant]                     skip the per-tenant ingest and arm
//     [--database-url <disposable db>] [--ingest-concurrency 4]
//     [--latest-name latest-qasper-retrieval-sparse-scoring]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

// Arms: RAG_SPARSE_SCORING and whether RAG_SPARSE_PRUNE_DF_FRACTION is the
// --prune-fraction ("configured") or off.
export const REGIMES = Object.freeze({
  global: Object.freeze([
    { id: "ts_rank_cd", pruneDfFraction: null, scoring: "ts_rank_cd" },
    { id: "ts_rank_cd_pruned", pruneDfFraction: "configured", scoring: "ts_rank_cd" },
    { id: "bm25", pruneDfFraction: null, scoring: "bm25" },
    { id: "bm25_pruned", pruneDfFraction: "configured", scoring: "bm25" },
  ]),
  single: Object.freeze([
    { id: "ts_rank_cd", pruneDfFraction: null, scoring: "ts_rank_cd" },
    { id: "bm25", pruneDfFraction: null, scoring: "bm25" },
  ]),
  tenant: Object.freeze([{ id: "bm25_tenant", pruneDfFraction: null, scoring: "bm25" }]),
});
export const ROUTES = Object.freeze(["hybrid", "sparse"]);
// Paired differences reported with CIs: [regime, minuend, regime, subtrahend].
export const COMPARISONS = Object.freeze([
  ["single", "bm25", "single", "ts_rank_cd"],
  ["global", "ts_rank_cd_pruned", "global", "ts_rank_cd"],
  ["global", "bm25_pruned", "global", "bm25"],
  ["global", "bm25", "global", "ts_rank_cd"],
  ["global", "bm25_pruned", "global", "ts_rank_cd"],
  ["tenant", "bm25_tenant", "single", "bm25"],
]);
// The raw sparse route over all papers, per question: [pruned, exhaustive].
export const RAW_PAIRS = Object.freeze([
  ["ts_rank_cd_pruned", "ts_rank_cd"],
  ["bm25_pruned", "bm25"],
]);
// Candidate paths grouped as the report slices them.
export const PATH_SLICES = Object.freeze({
  all_common: ["common_bounded"],
  mixed: ["pruned", "pruned_filled"],
  no_common: ["exhaustive"],
});

export const sliceOfPath = (path) =>
  Object.entries(PATH_SLICES).find(([, paths]) => paths.includes(path))?.[0] ?? "no_match";

// ---------------------------------------------------------------------------
// Pure helpers (test/vector-store-pgvector-bm25.test.mjs)
// ---------------------------------------------------------------------------

export const parseFractions = (value) =>
  String(value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((fraction) => Number.isFinite(fraction) && fraction > 0 && fraction < 1);

/**
 * How a pruned result list differs from the exhaustive one for the same query:
 * identical order, same set, and recall@K (|pruned ∩ exhaustive| / |exhaustive|;
 * 1 when both are empty).
 */
export const comparePrunedToExhaustive = (prunedIds, exhaustiveIds) => {
  const exhaustive = new Set(exhaustiveIds);
  const shared = prunedIds.filter((id) => exhaustive.has(id)).length;

  return {
    identical:
      prunedIds.length === exhaustiveIds.length && prunedIds.every((id, index) => id === exhaustiveIds[index]),
    recallAtK: exhaustive.size === 0 ? (prunedIds.length === 0 ? 1 : 0) : shared / exhaustive.size,
    sameSet: prunedIds.length === exhaustiveIds.length && shared === exhaustive.size,
  };
};

const round = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

export const summarizePruning = (comparisons) => {
  const count = comparisons.length;
  const differ = comparisons.filter((entry) => !entry.identical).length;
  const setDiffer = comparisons.filter((entry) => !entry.sameSet).length;

  return {
    meanRecallAtK: round(count ? comparisons.reduce((sum, entry) => sum + entry.recallAtK, 0) / count : null),
    minRecallAtK: round(count ? Math.min(...comparisons.map((entry) => entry.recallAtK)) : null),
    queries: count,
    queriesWithDifferentOrder: differ,
    queriesWithDifferentSet: setDiffer,
  };
};

/** The page an evidence paragraph sits on, with citations.js's fallbacks. */
export const pageOf = (result) => {
  const metadata = result?.document?.metadata ?? {};

  return Number(metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page);
};

/** `docId`: count only evidence of that paper (a search over several papers). */
export const recallRow = ({ confidence, docId = null, expectedPages, id, results }) => {
  const isEvidence = (result) =>
    expectedPages.has(pageOf(result)) && (docId === null || result?.document?.metadata?.docId === docId);
  const hitRank = results.findIndex(isEvidence);

  return {
    admitted: confidence.usableResults.some(isEvidence),
    hitAt1: hitRank === 0,
    hitAt3: hitRank >= 0 && hitRank < 3,
    hitAtAll: hitRank >= 0,
    id,
  };
};

const formatCi = (entry) => `${entry.delta} | [${entry.ci95?.join(", ") ?? "n/a"}]`;

export const formatMarkdown = (report) => {
  const { config, summary } = report;
  const lines = [
    "# Sparse scoring on the pgvector route: ts_rank_cd vs BM25, exhaustive and pruned",
    "",
    `Generated ${report.generatedAt}; corpus \`${config.corpus}\`, ${config.questions} answerable questions (seed ${config.seed}) over ${config.documents} papers (${config.chunks} chunks in the pooled scope); embedding ${config.embeddingModel}; PostgreSQL ${config.postgresVersion}. BM25 k1 ${config.k1}, b ${config.b}. Pruned arms: RAG_SPARSE_PRUNE_DF_FRACTION ${config.pruneDfFraction}, common-term cap ${config.commonTermCap ?? "off"}, pruning only above ${config.pruneMinChunks} chunks. Top-K ${config.retrievalTopK}, sparse top-K ${config.sparseTopK}.`,
    "",
    "Regimes: **single** = the question's own paper, all papers in one pooled owner scope (no paper exceeds the pruning minimum, so every arm is exhaustive); **global** = every sampled paper as the document set, where pruning runs; **tenant** = each paper ingested again under its own owner scope and retrieved as that tenant with row-level security enforced (BM25 statistics of that paper alone).",
    "",
    "## Evidence recall (retrieveQaCandidates)",
    "",
    "| Regime | Route | Arm | at rank 1 | top 3 | among candidates | admitted by the gate |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(summary.recall).flatMap(([regime, routes]) =>
      Object.entries(routes).flatMap(([route, arms]) =>
        Object.entries(arms).map(
          ([arm, entry]) =>
            `| ${regime} | ${route} | ${arm} | ${entry.hitAt1} | ${entry.hitAt3} | ${entry.hitAtAll} | ${entry.admitted} |`
        )
      )
    ),
    "",
    "Paired differences (bootstrap 95% CI over questions; an interval that contains 0 is not a demonstrated difference):",
    "",
    "| Route | Comparison | Metric | Delta | 95% CI |",
    "|---|---|---|---|---|",
    ...Object.entries(summary.comparisons).flatMap(([route, comparisons]) =>
      Object.entries(comparisons).flatMap(([label, comparison]) =>
        ["hitAt1", "hitAt3", "hitAtAll", "admitted"].map(
          (metric) => `| ${route} | ${label} | ${metric} | ${formatCi(comparison[metric])} |`
        )
      )
    ),
    "",
    "## Global regime by the path pruning took (the question's terms over all papers)",
    "",
    "mixed = some query terms rare, some common; all_common = every term common (one word or several: the capped path); no_common = no term common (pruning changes nothing).",
    "",
    "| Slice | Questions | Route | Arm | among candidates | pruned − exhaustive hitAtAll [95% CI] |",
    "|---|---|---|---|---|---|",
    ...Object.entries(summary.slices).flatMap(([slice, entry]) =>
      Object.entries(entry.recall).flatMap(([route, arms]) =>
        Object.entries(arms).map(([arm, recall]) => {
          const comparison = entry.comparisons?.[route]?.[arm];

          return `| ${slice} | ${entry.questions} | ${route} | ${arm} | ${recall.hitAtAll} | ${comparison ? `${comparison.hitAtAll.delta} [${comparison.hitAtAll.ci95?.join(", ") ?? "n/a"}]` : ""} |`;
        })
      )
    ),
    "",
    "## Raw sparse route over all papers: pruned against exhaustive, and latency (owner, no RLS)",
    "",
    "| Slice | Arm | Queries | Lists that differ | Sets that differ | Mean recall@K | Min recall@K | p50 ms | p95 ms | exhaustive p50 / p95 ms |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(summary.raw).flatMap(([slice, arms]) =>
      Object.entries(arms).map(
        ([arm, entry]) =>
          `| ${slice} | ${arm} | ${entry.lists.queries} | ${entry.lists.queriesWithDifferentOrder} | ${entry.lists.queriesWithDifferentSet} | ${entry.lists.meanRecallAtK} | ${entry.lists.minRecallAtK} | ${entry.latency.p50Ms} | ${entry.latency.p95Ms} | ${entry.exhaustiveLatency.p50Ms} / ${entry.exhaustiveLatency.p95Ms} |`
      )
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
};

const percentileOf = (values, fraction) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
};

export const summarizeLatency = (values) => ({
  count: values.length,
  p50Ms: round(percentileOf(values, 0.5), 2),
  p95Ms: round(percentileOf(values, 0.95), 2),
});

// ---------------------------------------------------------------------------
// Disposable cluster
// ---------------------------------------------------------------------------

const findPostgresBinaries = () => {
  const candidates = [
    process.env.PG_BIN_DIR,
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
  ].filter(Boolean);

  for (const directory of candidates) {
    if (existsSync(path.join(directory, "initdb"))) {
      return directory;
    }
  }

  const which = spawnSync("sh", ["-c", "command -v initdb"], { encoding: "utf8" });

  if (which.status === 0 && which.stdout.trim()) {
    return path.dirname(which.stdout.trim());
  }

  throw new Error("No initdb found; set PG_BIN_DIR or pass --database-url for a disposable database.");
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();

      server.close(() => resolve(port));
    });
  });

/** A throwaway cluster under $TMPDIR; stop() deletes it. */
export const startDisposableCluster = async () => {
  const bin = findPostgresBinaries();
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "sparse-scoring-pg-"));
  const port = await findFreePort();

  if ([5432, 5434, 6379].includes(port)) {
    throw new Error(`Refusing port ${port}.`);
  }

  const dataDirectory = path.join(workDirectory, "data");
  const passwordFile = path.join(workDirectory, "pw");

  await writeFile(passwordFile, "postgres\n");
  await mkdir(path.join(workDirectory, "sock"));
  execFileSync(path.join(bin, "initdb"), ["-D", dataDirectory, "-U", "postgres", "-A", "md5", `--pwfile=${passwordFile}`, "-E", "UTF8", "--no-locale"], { stdio: "ignore" });

  const options = [
    `-p ${port}`,
    `-k ${path.join(workDirectory, "sock")}`,
    "-c listen_addresses=127.0.0.1",
    "-c fsync=off -c full_page_writes=off -c synchronous_commit=off",
  ].join(" ");
  const stop = async () => {
    spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDirectory, "-m", "immediate", "stop"], { stdio: "ignore" });
    await rm(workDirectory, { force: true, recursive: true });
  };

  try {
    execFileSync(path.join(bin, "pg_ctl"), ["-D", dataDirectory, "-l", path.join(workDirectory, "pg.log"), "-w", "-t", "60", "-o", options, "start"], { stdio: "ignore" });
    execFileSync(path.join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "sparse_scoring"], {
      env: { ...process.env, PGPASSWORD: "postgres" },
      stdio: "ignore",
    });
    execFileSync(path.join(bin, "psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "sparse_scoring", "-qc", "CREATE EXTENSION IF NOT EXISTS vector"], {
      env: { ...process.env, PGPASSWORD: "postgres" },
      stdio: "ignore",
    });
  } catch (error) {
    await stop();
    throw error;
  }

  return { stop, url: `postgresql://postgres:postgres@127.0.0.1:${port}/sparse_scoring` };
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const APP_ENV_TO_CLEAR = Object.freeze([
  "LONG_MEMORY_DATABASE_URL",
  "RAG_BM25_B",
  "RAG_BM25_K1",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_RERANK_ENABLED",
  "RAG_RETRIEVAL_ROUTE",
  "RAG_SEMANTIC_CACHE",
  "RAG_SPARSE_COMMON_TERM_CAP",
  "RAG_SPARSE_PRUNE_DF_FRACTION",
  "RAG_SPARSE_SCORING",
]);

const withArm = async ({ arm, pruneDfFraction, route }, callback) => {
  process.env.RAG_SPARSE_SCORING = arm.scoring;
  process.env.RAG_SPARSE_PRUNE_DF_FRACTION =
    arm.pruneDfFraction === "configured" ? String(pruneDfFraction) : "off";

  if (route === "sparse") {
    process.env.RAG_RETRIEVAL_ROUTE = "sparse";
  } else {
    delete process.env.RAG_RETRIEVAL_ROUTE;
  }

  try {
    return await callback();
  } finally {
    delete process.env.RAG_SPARSE_SCORING;
    delete process.env.RAG_SPARSE_PRUNE_DF_FRACTION;
    delete process.env.RAG_RETRIEVAL_ROUTE;
  }
};

const mapLimit = async (items, limit, callback) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;

      next += 1;
      await callback(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
};

// The per-tenant copy of a paper: its own document id and owner scope.
export const tenantCopyOf = (key) => ({ docId: `tenant-${key}`, scope: { userId: `tenant-${key}`, workspaceId: "" } });

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const corpusPath = path.resolve(process.cwd(), option("--corpus", path.join(__dirname, "generated", "qasper-train.json")));
  const caseCount = Math.max(1, Number(option("--cases", "400")) || 400);
  const seed = Math.max(1, Number(option("--seed", "1")) || 1);
  const pruneDfFraction = parseFractions(option("--prune-fraction", "0.1"))[0] ?? 0.1;
  const withTenant = !args.includes("--no-tenant");
  const ingestConcurrency = Math.max(1, Number(option("--ingest-concurrency", "4")) || 4);
  const latestName = option(
    "--latest-name",
    `latest-qasper-retrieval-sparse-scoring-${path.basename(corpusPath, ".json")}`
  );

  if (!/^latest-qasper-retrieval[A-Za-z0-9_-]*$/.test(latestName)) {
    throw new Error("--latest-name must start with latest-qasper-retrieval (the results directory ignores those).");
  }

  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

  if (corpus.metadata?.granularity !== "paragraph") {
    throw new Error("Build the corpus with import-qasper.mjs --granularity paragraph so evidence is paragraph-level.");
  }

  const cluster = option("--database-url", null) ? null : await startDisposableCluster();
  const databaseUrl = option("--database-url", null) ?? cluster.url;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sparse-scoring-"));
  const cleanup = async () => {
    await rm(tempRoot, { force: true, recursive: true });
    await cluster?.stop();
  };

  for (const key of APP_ENV_TO_CLEAR) {
    delete process.env[key];
  }

  Object.assign(process.env, {
    POSTGRES_DATABASE_URL: databaseUrl,
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
    RAG_LONG_MEMORY_ENABLED: "false",
    SESSION_MEMORY_STORE_PROVIDER: "memory",
    VECTOR_STORE_PROVIDER: "pgvector",
  });

  try {
    const [{ sampleQasperCases }, { pairedRecallDeltas, summarizeRecallRows }] = await Promise.all([
      import("./run-qasper-answer-eval.mjs"),
      import("./run-qasper-retrieval-eval.mjs"),
    ]);
    const rag = await import("../chat.js");
    const { retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
    const { assessQaConfidence } = await import("../rag/confidence.js");
    const config = await import("../rag/config.js");
    const pgvector = await import("../rag/vector-store-pgvector.js");
    const sparse = await import("../rag/vector-store-pgvector-sparse.js");
    const postgres = await import("../rag/postgres.js");
    const tenant = await import("../rag/postgres-tenant.js");
    const cases = sampleQasperCases(
      corpus.cases.filter((testCase) => !testCase.shouldAbstain && testCase.expectedEvidence?.[0]?.pages?.length),
      caseCount,
      seed
    );
    const docKeys = new Set(cases.flatMap((testCase) => testCase.docKeys));
    const documents = corpus.documents.filter((doc) => docKeys.has(doc.key));
    const allDocIds = documents.map((doc) => doc.key);

    await rag.initializeDocumentRegistry();
    await rag.clearDocuments({ deleteFiles: false });
    await mkdir(path.join(tempRoot, "sources"), { recursive: true });
    console.log(
      `Ingesting ${documents.length} papers into pgvector${withTenant ? " (twice: pooled and one owner scope each)" : ""} for ${cases.length} questions...`
    );

    const ingestions = documents.flatMap((doc) => [
      { doc, docId: doc.key, scope: {} },
      ...(withTenant ? [{ doc, ...tenantCopyOf(doc.key) }] : []),
    ]);
    let ingested = 0;

    await mapLimit(ingestions, ingestConcurrency, async ({ doc, docId, scope }) => {
      const filePath = path.join(tempRoot, "sources", `${docId}.txt`);

      await writeFile(filePath, doc.pages.join("\n\n"), "utf8");

      for (let attempt = 1; ; attempt += 1) {
        try {
          await rag.ingestDocumentPages({
            docId,
            fileName: doc.fileName,
            filePath,
            ownerUserId: scope.userId,
            pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
            workspaceId: scope.workspaceId,
          });
          break;
        } catch (error) {
          if (attempt >= 3) {
            throw error;
          }

          console.warn(`ingest ${docId} failed (${error.message}); retrying`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }

      ingested += 1;

      if (ingested % 100 === 0) {
        console.log(`ingested ${ingested}/${ingestions.length}`);
      }
    });

    const serverVersion = (await postgres.queryPostgres("SHOW server_version")).rows[0].server_version;
    const pooledChunks = (
      await postgres.queryPostgres(`SELECT count(*)::int AS n FROM ${pgvector.getPgvectorTableName()} WHERE doc_id = ANY($1::text[])`, [allDocIds])
    ).rows[0].n;
    const sparseTopK = Math.max(config.getRetrievalTopK(), config.getSparseRetrievalTopK());
    const commonTermCap = config.getSparseCommonTermCap();
    const rows = Object.fromEntries(
      Object.entries(REGIMES).map(([regime, arms]) => [
        regime,
        Object.fromEntries(ROUTES.map((route) => [route, Object.fromEntries(arms.map(({ id }) => [id, []]))])),
      ])
    );
    const raw = Object.fromEntries(REGIMES.global.map(({ id }) => [id, []]));
    const pathById = new Map();

    const retrieve = async ({ arm, docId, docIds, expectedPages, id, question, route, scope = null }) => {
      const run = () =>
        withArm({ arm, pruneDfFraction, route }, () => retrieveQaCandidates({ docIds, resolvedQuery: question }));
      const { evidenceRequirementCount, results } = scope ? await tenant.runWithDatabaseTenant(scope, run) : await run();
      const confidence = assessQaConfidence({ evidenceRequirementCount, queryText: question, results });

      return recallRow({ confidence, docId, expectedPages, id, results });
    };

    for (const [index, testCase] of cases.entries()) {
      const expectedPages = new Set(testCase.expectedEvidence[0].pages);
      const paper = testCase.docKeys[0];
      const base = { expectedPages, id: testCase.id, question: testCase.question };

      for (const route of ROUTES) {
        for (const arm of REGIMES.single) {
          rows.single[route][arm.id].push(await retrieve({ ...base, arm, docId: null, docIds: [paper], route }));
        }

        for (const arm of REGIMES.global) {
          rows.global[route][arm.id].push(await retrieve({ ...base, arm, docId: paper, docIds: allDocIds, route }));
        }

        if (withTenant) {
          const copy = tenantCopyOf(paper);

          for (const arm of REGIMES.tenant) {
            rows.tenant[route][arm.id].push(
              await retrieve({ ...base, arm, docId: null, docIds: [copy.docId], route, scope: copy.scope })
            );
          }
        }
      }

      // The raw sparse route over all papers, as the owner: the path pruning
      // took, the lists and the latency.
      for (const arm of REGIMES.global) {
        const startedAt = performance.now();
        const results = await pgvector.searchPgvectorSparseDocuments({
          docIds: allDocIds,
          pruneDfFraction: arm.pruneDfFraction === "configured" ? pruneDfFraction : null,
          queryText: testCase.question,
          scoring: arm.scoring,
          topK: sparseTopK,
        });

        raw[arm.id].push({
          id: testCase.id,
          ids: results.map((result) => result.document.id),
          ms: performance.now() - startedAt,
          path: results[0]?.sparseCandidates ?? (results.length === 0 ? "none" : "plain"),
        });
      }

      pathById.set(testCase.id, raw.bm25_pruned.at(-1).path);

      if ((index + 1) % 50 === 0) {
        console.log(`retrieved ${index + 1}/${cases.length}`);
      }
    }

    const rowsOf = (regime, route, arm) => rows[regime]?.[route]?.[arm] ?? [];
    const comparisonsFor = (filter = () => true) =>
      Object.fromEntries(
        ROUTES.map((route) => [
          route,
          Object.fromEntries(
            COMPARISONS.filter(([leftRegime, , rightRegime]) => withTenant || (leftRegime !== "tenant" && rightRegime !== "tenant")).map(
              ([leftRegime, left, rightRegime, right]) => [
                `${leftRegime}:${left} − ${rightRegime}:${right}`,
                pairedRecallDeltas(
                  rowsOf(leftRegime, route, left).filter((row) => filter(row.id)),
                  rowsOf(rightRegime, route, right).filter((row) => filter(row.id))
                ),
              ]
            )
          ),
        ])
      );
    const sliceOfId = (id) => sliceOfPath(pathById.get(id));
    const slices = Object.fromEntries(
      [...Object.keys(PATH_SLICES), "no_match"]
        .map((slice) => [slice, cases.filter((testCase) => sliceOfId(testCase.id) === slice).map((testCase) => testCase.id)])
        .filter(([, ids]) => ids.length > 0)
        .map(([slice, ids]) => {
          const inSlice = new Set(ids);
          const keep = (row) => inSlice.has(row.id);

          return [
            slice,
            {
              comparisons: Object.fromEntries(
                ROUTES.map((route) => [
                  route,
                  Object.fromEntries(
                    RAW_PAIRS.map(([pruned, exhaustive]) => [
                      pruned,
                      pairedRecallDeltas(
                        rowsOf("global", route, pruned).filter(keep),
                        rowsOf("global", route, exhaustive).filter(keep)
                      ),
                    ])
                  ),
                ])
              ),
              questions: ids.length,
              recall: Object.fromEntries(
                ROUTES.map((route) => [
                  route,
                  Object.fromEntries(
                    REGIMES.global.map(({ id }) => [id, summarizeRecallRows(rowsOf("global", route, id).filter(keep))])
                  ),
                ])
              ),
            },
          ];
        })
    );
    const rawSummary = Object.fromEntries(
      Object.keys(slices).map((slice) => {
        const keep = (entry) => sliceOfId(entry.id) === slice;

        return [
          slice,
          Object.fromEntries(
            RAW_PAIRS.map(([pruned, exhaustive]) => {
              const prunedEntries = raw[pruned].filter(keep);
              const exhaustiveEntries = raw[exhaustive].filter(keep);

              return [
                pruned,
                {
                  exhaustiveLatency: summarizeLatency(exhaustiveEntries.map((entry) => entry.ms)),
                  latency: summarizeLatency(prunedEntries.map((entry) => entry.ms)),
                  lists: summarizePruning(
                    prunedEntries.map((entry, entryIndex) => comparePrunedToExhaustive(entry.ids, exhaustiveEntries[entryIndex].ids))
                  ),
                },
              ];
            })
          ),
        ];
      })
    );

    const report = {
      config: {
        b: config.getBm25B(),
        cases: caseCount,
        chunks: pooledChunks,
        commonTermCap,
        corpus: path.basename(corpusPath),
        documents: documents.length,
        embeddingModel: config.getEmbeddingModel(),
        k1: config.getBm25K1(),
        postgresVersion: serverVersion,
        pruneDfFraction,
        pruneMinChunks: sparse.PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS,
        questions: cases.length,
        retrievalTopK: config.getRetrievalTopK(),
        rowLevelSecurity: config.getPostgresRowLevelSecurityMode(),
        seed,
        sparseTopK,
        tenantRegime: withTenant,
        textSearchConfig: config.getPgvectorTextSearchConfig(),
        vectorStoreProvider: "pgvector",
      },
      generatedAt: new Date().toISOString(),
      raw: Object.fromEntries(Object.entries(raw).map(([arm, entries]) => [arm, entries.map(({ id, ids, ms, path: candidatePath }) => ({ candidatePath, id, ids, ms: round(ms, 3) }))])),
      reportType: "sparse-scoring",
      rows,
      summary: {
        comparisons: comparisonsFor(),
        raw: rawSummary,
        recall: Object.fromEntries(
          Object.entries(REGIMES)
            .filter(([regime]) => withTenant || regime !== "tenant")
            .map(([regime, arms]) => [
              regime,
              Object.fromEntries(
                ROUTES.map((route) => [
                  route,
                  Object.fromEntries(arms.map(({ id }) => [id, summarizeRecallRows(rowsOf(regime, route, id))])),
                ])
              ),
            ])
        ),
        slices,
      },
    };

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatMarkdown(report));
    process.stdout.write(formatMarkdown(report));
    await rag.clearDocuments({ deleteFiles: false });
    await postgres.resetPostgresPool();
  } finally {
    await cleanup();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
