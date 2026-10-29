// run-qasper-retrieval-eval.mjs
//
// Evidence recall of the single-document QA route on QASPER, measured where it
// matters: whether an annotated evidence paragraph is among the candidates
// retrieveQaCandidates returns (the QA route up to its gate), at rank 1, 3 and
// the whole list, and among the chunks the default gate admits (what the
// answer model sees). Answerable questions only; no chat model.
//
// Every row is kept, so two runs over the same sample (same corpus, --cases,
// --seed) can be compared question by question: --compare <other report.json>
// adds paired bootstrap 95% CIs for this run minus the other, and lists where
// the two runs' chunking settings, retrieval settings (config.retrieval: the
// route, fusion, pools, rerank, decomposition, BM25 and gate floors the run
// retrieved with) or commits differ (an older report without them counts as
// unknown). Each row also records admittedChars, the characters of the chunks
// the gate admits, so a chunker change that makes the context larger or
// smaller shows next to the recall it bought, and hitDenseRank/hitSparseRank,
// the rank each route gave the first evidence chunk (null when that route did
// not return it), so a fusion change shows which route the hits came through.
// The report's timing holds the ingest and retrieval wall time in ms.
//
// Usage (real embeddings, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
//   node evaluation/run-qasper-retrieval-eval.mjs
//     [--corpus evaluation/generated/qasper-train.json] [--cases 400] [--seed 1]
//     [--latest-name latest-qasper-retrieval] [--compare <report.json>]
//     [--min-hit-at-all <rate>]   exit 1 below this rate (the CI floor)

import "dotenv/config";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  describeChunkingConfig,
  describeEvaluationCheckout,
  describeRetrievalConfig,
  describeRunConfigDifferences,
  sumTextChars,
} from "./eval-run-config.js";
import {
  bootstrapClusterMeanInterval,
  bootstrapMeanInterval,
  createSeededRandom,
  roundTo4,
} from "./paired-bootstrap.js";
import { sampleQasperCases } from "./run-qasper-answer-eval.mjs";
import { useEvaluationDataDirectory } from "./eval-data-directory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

export const RECALL_METRICS = Object.freeze(["hitAt1", "hitAt3", "hitAtAll", "admitted"]);
// With --context-floors: whether the gate was confident, and whether evidence
// reached the context selectQaContext builds at each extra-candidate floor.
export const CONTEXT_FLOORS = Object.freeze([0, 0.01, 0.3]);
const contextMetric = (floor) => `context@${floor}`;

const mean = (values) =>
  values.length === 0 ? null : roundTo4(values.reduce((sum, value) => sum + value, 0) / values.length);

/** rows: { hitAt1, hitAt3, hitAtAll, admitted } booleans per question. */
const metricsOf = (rows) => [
  ...RECALL_METRICS,
  ...["gateConfident", ...CONTEXT_FLOORS.map(contextMetric)].filter((metric) =>
    rows.some((row) => metric in row)
  ),
];

// Per-question sizes (characters), averaged and compared as numbers; rows of
// reports written before a size was recorded have none and are left out.
export const SIZE_METRICS = Object.freeze(["admittedChars"]);
const sizesOf = (rows, metric) => rows.map((row) => row[metric]).filter((value) => Number.isFinite(value));
const roundSize = (value) => (value === null ? null : Number(value.toFixed(1)));

export const summarizeRecallRows = (rows) => ({
  ...Object.fromEntries(metricsOf(rows).map((metric) => [metric, mean(rows.map((row) => (row[metric] ? 1 : 0)))])),
  ...Object.fromEntries(
    SIZE_METRICS.filter((metric) => sizesOf(rows, metric).length > 0).map((metric) => {
      const sizes = sizesOf(rows, metric);

      return [`${metric}Mean`, roundSize(sizes.reduce((sum, value) => sum + value, 0) / sizes.length)];
    })
  ),
});

/**
 * Paired bootstrap of this run minus the other over the questions both ran:
 * resamples questions, so a question's two outcomes stay together. Each
 * recall metric also carries `flips` (questions this run won / lost) and,
 * when every paired row names its paper (`docKey`), `ci95ByPaper`: the
 * interval that resamples papers with all their questions, since the
 * questions of one paper share its chunks and vectors (dev has about three
 * per paper); it is drawn after every question-level interval, so those stay
 * what they were before it existed.
 */
export const pairedRecallDeltas = (rows, otherRows, { iterations = 4000, seed = 1 } = {}) => {
  const other = new Map(otherRows.map((row) => [row.id, row]));
  const pairs = rows.filter((row) => other.has(row.id)).map((row) => [row, other.get(row.id)]);
  // Every interval is drawn from this one RNG, in order.
  const random = createSeededRandom(seed);
  const bootstrap = (diffs, roundValue) => bootstrapMeanInterval(diffs, { iterations, random, roundValue });
  const diffsByMetric = metricsOf(rows).map((metric) => [
    metric,
    pairs.map(([left, right]) => (left[metric] ? 1 : 0) - (right[metric] ? 1 : 0)),
  ]);
  const recall = Object.fromEntries(
    diffsByMetric.map(([metric, diffs]) => [
      metric,
      {
        delta: mean(diffs),
        ci95: bootstrap(diffs, roundTo4),
        flips: { down: diffs.filter((diff) => diff < 0).length, up: diffs.filter((diff) => diff > 0).length },
      },
    ])
  );
  // After the recall metrics, so their intervals draw the same samples as
  // before sizes were compared. Only over pairs where both runs measured it.
  const sizes = Object.fromEntries(
    SIZE_METRICS.map((metric) => {
      const diffs = pairs
        .filter(([left, right]) => Number.isFinite(left[metric]) && Number.isFinite(right[metric]))
        .map(([left, right]) => left[metric] - right[metric]);

      return diffs.length === 0
        ? null
        : [
            metric,
            {
              cases: diffs.length,
              ci95: bootstrap(diffs, roundSize),
              delta: roundSize(diffs.reduce((sum, value) => sum + value, 0) / diffs.length),
            },
          ];
    }).filter(Boolean)
  );
  const clustered = pairs.length > 0 && pairs.every(([left]) => typeof left.docKey === "string" && left.docKey);

  if (clustered) {
    const groupsOf = (diffs) => {
      const byPaper = new Map();

      pairs.forEach(([left], index) => {
        byPaper.set(left.docKey, [...(byPaper.get(left.docKey) ?? []), diffs[index]]);
      });

      return [...byPaper.values()];
    };

    for (const [metric, diffs] of diffsByMetric) {
      recall[metric].ci95ByPaper = bootstrapClusterMeanInterval(groupsOf(diffs), { iterations, random, roundValue: roundTo4 });
    }
  }

  return {
    cases: pairs.length,
    ...(clustered ? { papers: new Set(pairs.map(([left]) => left.docKey)).size } : {}),
    ...recall,
    ...sizes,
  };
};

// Same fallbacks as citations.js reads a page number with.
const pageOf = (result) => {
  const metadata = result?.document?.metadata ?? {};

  return Number(metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page);
};

const rankOrNull = (value) => (Number.isFinite(value) ? value : null);

// The rank a route gave a candidate: a fused result carries denseRank /
// sparseRank (null for a route that did not return it); the dense-only route
// stamps only provenance.routes. Under query decomposition the merged copy is
// the sub-query's whose copy won, so the rank is within that sub-query's
// route list.
const routeRankOf = (result, route) =>
  rankOrNull(
    result?.[`${route}Rank`] ?? result?.provenance?.routes?.find((entry) => entry?.route === route)?.rank
  );

/**
 * The first candidate on an evidence page: its 1-based position in the
 * candidate list, and the rank each route gave it. hitRank null when no
 * candidate is on an evidence page.
 */
export const describeEvidenceHit = (results, expectedPages) => {
  const expected = expectedPages instanceof Set ? expectedPages : new Set(expectedPages);
  const index = (Array.isArray(results) ? results : []).findIndex((result) => expected.has(pageOf(result)));
  const hit = index >= 0 ? results[index] : null;

  return {
    hitDenseRank: hit ? routeRankOf(hit, "dense") : null,
    hitRank: index >= 0 ? index + 1 : null,
    hitSparseRank: hit ? routeRankOf(hit, "sparse") : null,
  };
};

/**
 * Candidates the sparse route returned and the dense route did not. Under the
 * default fusion (RRF, k 60, weights 0.65/0.35, dense pool 8) there can be
 * none: a sparse-only chunk scores at most 0.35 against 0.583 for dense rank
 * 8, so every candidate is in the dense top 8. Any row with a count above 0
 * refutes that for its run.
 */
export const countSparseOnlyCandidates = (results) =>
  (Array.isArray(results) ? results : []).filter(
    (result) => routeRankOf(result, "sparse") !== null && routeRankOf(result, "dense") === null
  ).length;

/**
 * Two reports pair by question id, so they must come from the same sample:
 * the same corpus file, seed and requested case count. A report from before
 * a field is not refused on that field.
 */
export const assertComparableSample = (config, otherConfig = {}, { label = "the other report" } = {}) => {
  for (const field of ["corpus", "seed", "cases"]) {
    const other = otherConfig?.[field];

    if (other !== undefined && other !== null && !Object.is(other, config[field])) {
      throw new Error(
        `${label} ran ${field} ${JSON.stringify(other)}, this run ${JSON.stringify(config[field])}: the questions would not pair.`
      );
    }
  }
};

const formatRetrieval = (retrieval) =>
  retrieval
    ? `${retrieval.route}${retrieval.hybridEnabled ? `/${retrieval.fusion}${retrieval.fusion === "rrf" ? ` k=${retrieval.rrfK}` : ""} weights ${retrieval.denseWeight}/${retrieval.sparseWeight}, sparse top-K ${retrieval.sparseTopK}` : " (hybrid off)"}, rerank ${retrieval.rerankEnabled ? `${retrieval.rerankProvider} x${retrieval.rerankCandidateMultiplier} w=${retrieval.rerankWeight}` : "off"}, decomposition ${retrieval.queryDecomposition ? `up to ${retrieval.maxQueryRequirements}` : "off"}, BM25 k1=${retrieval.bm25K1} b=${retrieval.bm25B}, gate relevance ${retrieval.minRelevanceScore} coverage ${retrieval.minQaQueryTermCoverage}${retrieval.qaGateInflection ? " inflection" : ""}${retrieval.qaAnswerVerdict ? " verdict" : ""}`
    : "unknown";

const formatChunking = (chunking) =>
  chunking
    ? `${chunking.strategy}/${chunking.size}/${chunking.overlap}, chunker ${chunking.chunkerVersion}`
    : "unknown";

const formatCheckout = (git) =>
  git ? `${git.sha.slice(0, 12)}${git.dirty ? ` with ${git.changedPaths} uncommitted path(s)` : ""}` : "unknown";

const formatMarkdown = (report) => {
  const { summary, config, comparison } = report;
  const lines = [
    "# QASPER evidence recall (single-document QA route)",
    "",
    `Generated ${report.generatedAt}; corpus \`${config.corpus}\`; ${report.rows.length} answerable questions, seed ${config.seed}; embedding ${config.embeddingModel} (query prefix ${JSON.stringify(config.queryPrefix)}, document prefix ${JSON.stringify(config.documentPrefix)}); retrieval top-K ${config.retrievalTopK}; query adapter ${config.queryAdapter ?? "none"}; chunking ${formatChunking(config.chunking)}; retrieval ${formatRetrieval(config.retrieval)}; commit ${formatCheckout(config.git)}.`,
    ...(report.timing
      ? [`Ingest ${Math.round(report.timing.ingestMs / 1000)} s, retrieval ${Math.round(report.timing.retrievalMs / 1000)} s.`]
      : []),
    "",
    "| Evidence paragraph ... | Rate |",
    "|---|---|",
    `| at rank 1 | ${summary.hitAt1} |`,
    `| in the top 3 | ${summary.hitAt3} |`,
    `| among all candidates | ${summary.hitAtAll} |`,
    `| among the chunks the gate admits | ${summary.admitted} |`,
    ...CONTEXT_FLOORS.filter((floor) => contextMetric(floor) in summary).map(
      (floor) => `| in the widened context (extra candidates from coverage ${floor}) | ${summary[contextMetric(floor)]} |`
    ),
    ...("gateConfident" in summary ? [`| (questions the gate answers) | ${summary.gateConfident} |`] : []),
    ...("admittedCharsMean" in summary
      ? ["", `Admitted context: ${summary.admittedCharsMean} characters per question on average.`]
      : []),
  ];

  if (comparison) {
    if (comparison.configDifferences?.length > 0) {
      lines.push(
        "",
        `The two runs differ, or cannot be shown to match, in ${comparison.configDifferences
          .map(
            ({ current, field, other }) =>
              `${field} (${current === null ? "unknown" : JSON.stringify(current)} here, ${other === null ? "unknown" : JSON.stringify(other)} there)`
          )
          .join("; ")}: a delta below may come from that, not only from what was meant to change.`
      );
    }

    const byPaper = comparison.papers !== undefined;

    lines.push(
      "",
      `Paired against \`${comparison.against}\` (${comparison.cases} questions${byPaper ? ` of ${comparison.papers} papers` : ""}; this run minus that one, bootstrap 95% CI over questions${byPaper ? ", and over papers with all their questions" : ""}; flips = questions this run won / lost):`,
      "",
      `| Metric | Delta | 95% CI |${byPaper ? " 95% CI by paper |" : ""} Flips |`,
      `|---|---|---|${byPaper ? "---|" : ""}---|`,
      ...Object.keys(comparison)
        .filter((metric) => comparison[metric]?.ci95 !== undefined)
        .map((metric) => {
          const entry = comparison[metric];
          const flips = entry.flips ? `+${entry.flips.up} / -${entry.flips.down}` : "";
          const paper = byPaper ? ` ${entry.ci95ByPaper ? `[${entry.ci95ByPaper.join(", ")}]` : ""} |` : "";

          return `| ${metric} | ${entry.delta} | [${entry.ci95?.join(", ")}] |${paper} ${flips} |`;
        })
    );
  }

  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const corpusPath = path.resolve(
    process.cwd(),
    option("--corpus", path.join(__dirname, "generated", "qasper-train.json"))
  );
  const caseCount = Math.max(1, Number(option("--cases", "400")) || 400);
  const seed = Math.max(1, Number(option("--seed", "1")) || 1);
  const latestName = option("--latest-name", "latest-qasper-retrieval");
  const comparePath = option("--compare", null);
  const iterations = Math.max(1, Math.floor(Number(option("--iterations", "4000")) || 4000));
  // A regression floor for CI: exit 1 when evidence among the candidates
  // falls below it.
  const minHitAtAll = option("--min-hit-at-all", null);
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  // The checkout, before the run writes anything.
  const git = await describeEvaluationCheckout();

  if (corpus.metadata?.granularity !== "paragraph") {
    throw new Error("Build the corpus with import-qasper.mjs --granularity paragraph so evidence is paragraph-level.");
  }

  const cases = sampleQasperCases(
    corpus.cases.filter((testCase) => !testCase.shouldAbstain && testCase.expectedEvidence?.[0]?.pages?.length),
    caseCount,
    seed
  );
  const docKeys = new Set(cases.flatMap((testCase) => testCase.docKeys));
  const documents = corpus.documents.filter((doc) => docKeys.has(doc.key));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qasper-retrieval-"));

  useEvaluationDataDirectory(path.join(tempRoot, "rag-data"));
  process.env.DOCCOMPARE_STANDALONE = "1";

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
  const { assessQaConfidence, selectQaContext } = await import("../rag/confidence.js");
  const config = await import("../rag/config.js");
  const { assertSameQueryAdapterFingerprint, getQueryAdapterReportFingerprint } = await import(
    "../rag/query-adapter.js"
  );
  // RAG_EMBEDDING_QUERY_ADAPTER reorders this route's dense candidates; a
  // --compare against a run made with another adapter (or none) is refused
  // before the ingest.
  const queryAdapter = getQueryAdapterReportFingerprint();
  const other = comparePath ? JSON.parse(await readFile(path.resolve(process.cwd(), comparePath), "utf8")) : null;

  if (other) {
    assertSameQueryAdapterFingerprint(queryAdapter, other.config?.queryAdapter, { label: path.basename(comparePath) });
    assertComparableSample({ cases: caseCount, corpus: path.basename(corpusPath), seed }, other.config, {
      label: path.basename(comparePath),
    });
  }

  const rows = [];
  const timing = { ingestMs: null, retrievalMs: null };

  try {
    await rag.initializeDocumentRegistry();
    await mkdir(path.join(tempRoot, "sources"), { recursive: true });
    console.log(`Ingesting ${documents.length} papers for ${cases.length} questions...`);

    const ingestStartedAt = performance.now();

    for (const doc of documents) {
      const filePath = path.join(tempRoot, "sources", `${doc.key}.txt`);

      await writeFile(filePath, doc.pages.join("\n\n"), "utf8");

      // A local embedding server can restart its runner mid-run and report
      // it as a 400; a long ingest should not be lost to one such blip.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await rag.ingestDocumentPages({
            docId: doc.key,
            filePath,
            fileName: doc.fileName,
            pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
          });
          break;
        } catch (error) {
          if (attempt >= 3) {
            throw error;
          }

          console.warn(`ingest ${doc.key} failed (${error.message}); retrying`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    timing.ingestMs = Math.round(performance.now() - ingestStartedAt);
    const retrievalStartedAt = performance.now();

    for (const [index, testCase] of cases.entries()) {
      const expected = new Set(testCase.expectedEvidence[0].pages);
      const { evidenceRequirementCount, results } = await retrieveQaCandidates({
        docIds: [testCase.docKeys[0]],
        resolvedQuery: testCase.question,
      });
      const { hitDenseRank, hitRank, hitSparseRank } = describeEvidenceHit(results, expected);
      const sparseOnlyCandidateCount = countSparseOnlyCandidates(results);
      const confidence = assessQaConfidence({
        evidenceRequirementCount,
        queryText: testCase.question,
        results,
      });

      const contextHits = Object.fromEntries(
        CONTEXT_FLOORS.map((floor) => [
          contextMetric(floor),
          selectQaContext({
            confidence,
            limit: config.getRetrievalTopK(),
            minCoverage: floor,
            queryText: testCase.question,
            results,
          }).some((result) => expected.has(pageOf(result))),
        ])
      );

      rows.push({
        ...contextHits,
        gateConfident: confidence.confident,
        admitted: confidence.usableResults.some((result) => expected.has(pageOf(result))),
        admittedChars: sumTextChars(confidence.usableResults, (result) => result?.document?.pageContent),
        candidateCount: results.length,
        docKey: testCase.docKeys[0],
        evidenceRequirementCount,
        hitAt1: hitRank === 1,
        hitAt3: hitRank !== null && hitRank <= 3,
        hitAtAll: hitRank !== null,
        hitDenseRank,
        hitRank,
        hitSparseRank,
        id: testCase.id,
        sparseOnlyCandidateCount,
      });

      if ((index + 1) % 100 === 0) {
        console.log(`retrieved ${index + 1}/${cases.length}`);
      }
    }

    timing.retrievalMs = Math.round(performance.now() - retrievalStartedAt);

    const reportConfig = {
      cases: caseCount,
      chunking: await describeChunkingConfig(),
      corpus: path.basename(corpusPath),
      documentPrefix: config.getEmbeddingDocumentPrefix(),
      embeddingModel: config.getEmbeddingModel(),
      git,
      queryAdapter,
      queryPrefix: config.getEmbeddingQueryPrefix(),
      retrieval: await describeRetrievalConfig(),
      retrievalTopK: config.getRetrievalTopK(),
      seed,
    };
    const report = {
      comparison: other
        ? {
            against: path.basename(comparePath),
            configDifferences: describeRunConfigDifferences(reportConfig, other.config ?? {}),
            ...pairedRecallDeltas(rows, other.rows ?? [], { iterations }),
          }
        : null,
      config: reportConfig,
      generatedAt: new Date().toISOString(),
      reportType: "qasper-retrieval",
      rows,
      summary: summarizeRecallRows(rows),
      timing,
    };

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatMarkdown(report));
    process.stdout.write(formatMarkdown(report));

    if (minHitAtAll !== null && report.summary.hitAtAll < Number(minHitAtAll)) {
      console.error(`Evidence among the candidates ${report.summary.hitAtAll} is below the floor ${minHitAtAll}.`);
      process.exitCode = 1;
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
