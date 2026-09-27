// run-query-adapter-eval.mjs
//
// Does the query-side embedding adapter (rag/query-adapter.js) put QASPER
// evidence in front of the single-document QA route, and into the context the
// answer model reads? The sampled papers are ingested once through the app
// (local index, real embeddings); then every question runs
// retrieveQaCandidates -- the QA route up to its gate -- on the hybrid route
// twice, without and with the adapter. The adapter applies there only (the
// dense-only route measured worse and is never adapted). It is switched
// through RAG_EMBEDDING_QUERY_ADAPTER, the setting a server reads. Every
// adapter-arm question must carry the fingerprint on its dense-route
// provenance and no identity-arm question may, and a chunk the dense route
// ranked in both arms must carry the same vectorScore in both (the adapter
// reorders; the admission floors keep reading the model's cosine), or the run
// fails: the report proves which arm ran rather than trusting the flag.
//
// Answerable questions: evidence at rank 1, in the top 3, among all
// candidates, among the chunks the default gate admits, and in the context
// selectQaContext builds (what the answer model reads), plus how many extra
// candidates that context takes. Unanswerable questions: how often the gate
// admits anything (a false admission; the route would answer). Arms are
// compared with paired bootstrap 95% CIs over the same questions.
//
// Pre-declared rule: a retrieval gain only if, on the hybrid route, evidence
// among the candidates AND evidence in the answer model's context both
// improve with intervals that exclude 0, AND the false-admission rate on
// unanswerable questions shows no increase (its interval's lower bound is at
// most 0). That is necessary, not sufficient, for recommending it: answer
// quality is measured separately (eval:qasper-answers with and without the
// adapter), and a retrieval gain does not make answers better by itself.
//
// Usage (local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
//   node evaluation/run-query-adapter-eval.mjs
//     [--adapter evaluation/generated/query-adapter/qasper-nomic-adapter.json]
//     [--corpus evaluation/generated/qasper-dev.json] [--cases 100000] [--seed 1]
//     [--latest-name latest-qasper-retrieval-query-adapter]

import "dotenv/config";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sampleQasperCases } from "./run-qasper-answer-eval.mjs";
import { pairedRecallDeltas, summarizeRecallRows } from "./run-qasper-retrieval-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

// The adapter applies on the hybrid route only (rag/query-adapter.js).
export const ADAPTER_EVAL_ROUTE = "hybrid";
// selectQaContext's extra-candidate floor in the QA route
// (QA_CONTEXT_MIN_COVERAGE in rag/document-rag-execution.js is 0).
export const CONTEXT_METRIC = "context@0";

const PAGE_OF = (result) => {
  const metadata = result?.document?.metadata ?? {};

  return Number(metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page);
};

const round = (value) => (value === null ? null : Number(value.toFixed(4)));

/**
 * One answerable question's row: recall as eval:qasper-retrieval scores it,
 * plus whether evidence reached the context the answer model reads and how
 * many extra candidates that context took beyond the admitted chunks.
 */
export const scoreAdapterRow = ({ id, expectedPages, results, admittedResults, contextResults = [], gateConfident = false }) => {
  const expected = new Set(expectedPages.map(Number));
  const hitRank = results.findIndex((result) => expected.has(PAGE_OF(result)));

  return {
    admitted: admittedResults.some((result) => expected.has(PAGE_OF(result))),
    candidateCount: results.length,
    [CONTEXT_METRIC]: contextResults.some((result) => expected.has(PAGE_OF(result))),
    extraCount: Math.max(0, contextResults.length - admittedResults.length),
    gateConfident: Boolean(gateConfident),
    hitAt1: hitRank === 0,
    hitAt3: hitRank >= 0 && hitRank < 3,
    hitAtAll: hitRank >= 0,
    hitRank: hitRank >= 0 ? hitRank + 1 : null,
    id,
  };
};

/**
 * The fingerprints on a question's dense-route provenance: what proves an arm
 * ran with (or without) the adapter.
 */
export const collectAdapterStamps = (results) =>
  [
    ...new Set(
      results
        .filter((result) => (result?.provenance?.routes ?? []).some((route) => route?.route === "dense"))
        .map((result) => result.provenance.queryAdapter ?? null)
    ),
  ];

// A merged candidate keeps the copy of the retrieval query that scored it
// highest (mergeRetrievedResults), so its vectorScore is that query's cosine:
// key by chunk and that query.
const denseScores = (results) =>
  new Map(
    results
      .filter((result) => (result?.provenance?.routes ?? []).some((route) => route?.route === "dense"))
      .map((result) => [
        `${result.document?.metadata?.docId}:${result.document?.metadata?.chunkIndex}@${result.provenance?.queries?.[0]?.queryId ?? ""}`,
        Number(result.vectorScore),
      ])
  );

/**
 * Chunks one retrieval query's dense route ranked in both arms, and how many
 * of them carry another vectorScore with the adapter on: must be none (beyond
 * float noise), since the adapter only reorders and admission reads
 * vectorScore. W q alone moves these cosines by tenths.
 */
export const countVectorScoreDrift = (identityResults, adapterResults, tolerance = 1e-6) => {
  const identity = denseScores(identityResults);
  const drift = { compared: 0, drifted: 0, maxAbsDiff: 0 };

  for (const [key, score] of denseScores(adapterResults)) {
    if (!identity.has(key)) {
      continue;
    }

    const difference = Math.abs(identity.get(key) - score);

    drift.compared += 1;
    drift.drifted += difference > tolerance ? 1 : 0;
    drift.maxAbsDiff = Math.max(drift.maxAbsDiff, difference);
  }

  return drift;
};

// mulberry32, as the other QASPER harnesses sample with.
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

/** Paired bootstrap of a numeric field, this arm minus the other, by question. */
export const pairedMeanDelta = (rows, otherRows, field, { iterations = 4000, seed = 1 } = {}) => {
  const other = new Map(otherRows.map((row) => [row.id, row]));
  const diffs = rows
    .filter((row) => other.has(row.id))
    .map((row) => (Number(row[field]) || 0) - (Number(other.get(row.id)[field]) || 0));

  if (diffs.length === 0) {
    return { cases: 0, ci95: null, delta: null };
  }

  const random = createSeededRandom(seed);
  const samples = [];

  for (let index = 0; index < iterations; index += 1) {
    let sum = 0;

    for (let draw = 0; draw < diffs.length; draw += 1) {
      sum += diffs[Math.floor(random() * diffs.length)];
    }

    samples.push(sum / diffs.length);
  }

  samples.sort((left, right) => left - right);

  return {
    cases: diffs.length,
    ci95: [round(samples[Math.floor(iterations * 0.025)]), round(samples[Math.floor(iterations * 0.975)])],
    delta: round(diffs.reduce((sum, value) => sum + value, 0) / diffs.length),
  };
};

const meanOf = (rows, field) =>
  rows.length === 0 ? null : round(rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0) / rows.length);

/**
 * The pre-declared rule. `answerable` is pairedRecallDeltas of adapter minus
 * identity over answerable questions; `unanswerable` the same over
 * unanswerable ones, where gateConfident is a false admission.
 */
export const decideQueryAdapter = ({ answerable, unanswerable }) => {
  const lower = (entry) => entry?.ci95?.[0];
  const format = (entry) =>
    entry ? `${entry.delta >= 0 ? "+" : ""}${entry.delta} [${entry.ci95?.join(", ")}]` : "not measured";
  const checks = [
    {
      metric: `${ADAPTER_EVAL_ROUTE}.hitAtAll`,
      pass: Number.isFinite(lower(answerable?.hitAtAll)) && lower(answerable.hitAtAll) > 0,
      rule: "improves, CI excludes 0",
      value: format(answerable?.hitAtAll),
    },
    {
      metric: `${ADAPTER_EVAL_ROUTE}.${CONTEXT_METRIC}`,
      pass: Number.isFinite(lower(answerable?.[CONTEXT_METRIC])) && lower(answerable[CONTEXT_METRIC]) > 0,
      rule: "improves, CI excludes 0",
      value: format(answerable?.[CONTEXT_METRIC]),
    },
    {
      metric: "unanswerable.falseAdmit",
      pass: Number.isFinite(lower(unanswerable?.gateConfident)) && lower(unanswerable.gateConfident) <= 0,
      rule: "no measured increase (CI lower bound <= 0)",
      value: format(unanswerable?.gateConfident),
    },
  ];
  const failed = checks.filter((check) => !check.pass);

  return {
    checks,
    recommend: failed.length === 0,
    reason:
      failed.length === 0
        ? "Every pre-declared retrieval condition holds. This is a retrieval result only: whether answers improve is eval:qasper-answers with and without the adapter."
        : `No retrieval gain: ${failed.map((check) => `${check.metric} ${check.value} (needs: ${check.rule})`).join("; ")}.`,
  };
};

export const formatAdapterReportMarkdown = (report) => {
  const { config, arms, comparisons, decision } = report;
  const metrics = ["hitAt1", "hitAt3", "hitAtAll", "admitted", CONTEXT_METRIC];
  const lines = [
    "# Query-side embedding adapter on QASPER (single-document QA route, hybrid)",
    "",
    `Generated ${report.generatedAt}; corpus \`${config.corpus}\`; ${config.questions} answerable + ${config.unanswerableQuestions} unanswerable questions (seed ${config.seed}); embedding ${config.embeddingModel} (query prefix ${JSON.stringify(config.queryPrefix)}, document prefix ${JSON.stringify(config.documentPrefix)}); retrieval top-K ${config.retrievalTopK}; adapter \`${config.adapter.file}\` fingerprint \`${config.adapter.fingerprint}\` (trained on ${config.adapter.trainedOn ?? "?"}). vectorScore of the ${config.vectorScoreDrift.compared} (chunk, retrieval query) pairs the dense route ranked in both arms: ${config.vectorScoreDrift.drifted === 0 ? "identical" : `${config.vectorScoreDrift.drifted} differ`} (max difference ${config.vectorScoreDrift.maxAbsDiff}).`,
    "",
    "| Arm | at rank 1 | top 3 | among candidates | admitted by the gate | in the answer model's context | extra context chunks (mean) | unanswerable: gate admits (false admission) |",
    "|---|---|---|---|---|---|---|---|",
    ...["identity", "adapter"].map((arm) => {
      const summary = arms[arm].summary;
      return `| ${arm} | ${summary.hitAt1} | ${summary.hitAt3} | ${summary.hitAtAll} | ${summary.admitted} | ${summary[CONTEXT_METRIC]} | ${arms[arm].meanExtraCount} | ${arms[arm].unanswerableSummary.gateConfident} |`;
    }),
    "",
    "Adapter minus identity, paired over the same questions (bootstrap 95% CI):",
    "",
    "| Questions | Metric | Delta | 95% CI |",
    "|---|---|---|---|",
    ...metrics.map(
      (metric) => `| answerable | ${metric} | ${comparisons.answerable[metric].delta} | [${comparisons.answerable[metric].ci95?.join(", ")}] |`
    ),
    `| answerable | extra context chunks | ${comparisons.extraCount.delta} | [${comparisons.extraCount.ci95?.join(", ")}] |`,
    `| unanswerable | false admission | ${comparisons.unanswerable.gateConfident.delta} | [${comparisons.unanswerable.gateConfident.ci95?.join(", ")}] |`,
    "",
    `Decision (pre-declared: ${decision.checks.map((check) => `${check.metric} ${check.rule}`).join("; ")}): **${decision.recommend ? "retrieval gain (still default off)" : "no retrieval gain (still default off)"}**. ${decision.reason}`,
  ];

  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const corpusPath = path.resolve(process.cwd(), option("--corpus", path.join(__dirname, "generated", "qasper-dev.json")));
  const adapterPath = path.resolve(
    process.cwd(),
    option("--adapter", path.join(__dirname, "generated", "query-adapter", "qasper-nomic-adapter.json"))
  );
  const caseCount = Math.max(1, Number(option("--cases", "100000")) || 100000);
  const seed = Math.max(1, Number(option("--seed", "1")) || 1);
  const latestName = option("--latest-name", "latest-qasper-retrieval-query-adapter");
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

  if (corpus.metadata?.granularity !== "paragraph") {
    throw new Error("Build the corpus with import-qasper.mjs --granularity paragraph so evidence is paragraph-level.");
  }

  const cases = sampleQasperCases(
    corpus.cases.filter((testCase) => !testCase.shouldAbstain && testCase.expectedEvidence?.[0]?.pages?.length),
    caseCount,
    seed
  );
  const unanswerableCases = sampleQasperCases(
    corpus.cases.filter((testCase) => testCase.shouldAbstain && testCase.docKeys?.length === 1),
    caseCount,
    seed
  );
  const docKeys = new Set([...cases, ...unanswerableCases].flatMap((testCase) => testCase.docKeys));
  const documents = corpus.documents.filter((doc) => docKeys.has(doc.key));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "query-adapter-eval-"));

  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");
  process.env.DOCCOMPARE_STANDALONE = "1";
  delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;
  delete process.env.RAG_RETRIEVAL_ROUTE;
  process.env.RAG_HYBRID_ENABLED = "true";
  // Both arms read the same model query vectors (the cache holds the model's
  // vectors; the adapter is applied per search), so size the cache and its
  // lifetime for the whole run instead of re-embedding the second arm.
  process.env.RAG_EMBEDDING_CACHE_MAX = "1000000";
  process.env.RAG_EMBEDDING_CACHE_TTL_MS = String(24 * 60 * 60 * 1000);

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { QA_CONTEXT_MIN_COVERAGE, retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
  const { assessQaConfidence, selectQaContext } = await import("../rag/confidence.js");
  const { describeQueryAdapter, describeQueryAdapterHealth } = await import("../rag/query-adapter.js");
  const { describeVectorStoreRuntime, supportsDenseScoreVector } = await import("../rag/vector-store.js");
  const config = await import("../rag/config.js");

  if (`context@${QA_CONTEXT_MIN_COVERAGE}` !== CONTEXT_METRIC) {
    throw new Error(`QA_CONTEXT_MIN_COVERAGE is ${QA_CONTEXT_MIN_COVERAGE}; update CONTEXT_METRIC.`);
  }

  try {
    // Fail before an hour of ingest when the adapter cannot apply here.
    process.env.RAG_EMBEDDING_QUERY_ADAPTER = adapterPath;
    const health = describeQueryAdapterHealth({ hybrid: true, supportsScoreVector: supportsDenseScoreVector() });

    if (health.status !== "ok" || health.warnings?.length) {
      throw new Error(`The adapter would not apply: ${health.message}`);
    }

    const adapter = describeQueryAdapter();
    const training = JSON.parse(await readFile(adapterPath, "utf8")).training ?? null;
    delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;

    await rag.initializeDocumentRegistry();
    await mkdir(path.join(tempRoot, "sources"), { recursive: true });
    console.log(
      `Ingesting ${documents.length} papers for ${cases.length} answerable + ${unanswerableCases.length} unanswerable questions...`
    );

    for (const doc of documents) {
      const filePath = path.join(tempRoot, "sources", `${doc.key}.txt`);

      await writeFile(filePath, doc.pages.join("\n\n"), "utf8");

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

    const runtime = { ...describeVectorStoreRuntime(), denseScoring: "dense" };
    const arms = {};
    const identityResults = new Map();
    const vectorScoreDrift = { compared: 0, drifted: 0, maxAbsDiff: 0 };

    for (const arm of ["identity", "adapter"]) {
      if (arm === "adapter") {
        process.env.RAG_EMBEDDING_QUERY_ADAPTER = adapterPath;
      } else {
        delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;
      }

      const rows = [];
      const unanswerableRows = [];
      let stampedQuestions = 0;

      for (const testCase of [...cases, ...unanswerableCases]) {
        const { evidenceRequirementCount, results } = await retrieveQaCandidates({
          docIds: [testCase.docKeys[0]],
          resolvedQuery: testCase.question,
        });
        const stamps = collectAdapterStamps(results);
        const expected = arm === "adapter" ? adapter.fingerprint : null;

        if (!stamps.every((stamp) => stamp === expected)) {
          throw new Error(
            `${arm} ${testCase.id}: dense provenance carries ${JSON.stringify(stamps)}, expected only ${JSON.stringify(expected)}.`
          );
        }

        stampedQuestions += stamps.includes(adapter.fingerprint) ? 1 : 0;

        if (arm === "identity") {
          identityResults.set(testCase.id, results);
        } else {
          const drift = countVectorScoreDrift(identityResults.get(testCase.id) ?? [], results);

          vectorScoreDrift.compared += drift.compared;
          vectorScoreDrift.drifted += drift.drifted;
          vectorScoreDrift.maxAbsDiff = Math.max(vectorScoreDrift.maxAbsDiff, drift.maxAbsDiff);
        }

        const confidence = assessQaConfidence({ evidenceRequirementCount, queryText: testCase.question, results });

        if (testCase.shouldAbstain) {
          unanswerableRows.push({ candidateCount: results.length, gateConfident: confidence.confident, id: testCase.id });
          continue;
        }

        // What executeQaRag hands the answer model.
        const contextResults = confidence.confident
          ? selectQaContext({
              confidence,
              limit: config.getRetrievalTopK(),
              minCoverage: QA_CONTEXT_MIN_COVERAGE,
              queryText: testCase.question,
              results,
            })
          : confidence.usableResults;

        rows.push(
          scoreAdapterRow({
            admittedResults: confidence.usableResults,
            contextResults,
            expectedPages: testCase.expectedEvidence[0].pages,
            gateConfident: confidence.confident,
            id: testCase.id,
            results,
          })
        );
      }

      if (arm === "adapter" && stampedQuestions === 0) {
        throw new Error("adapter arm: no question's dense route carries the adapter fingerprint.");
      }

      arms[arm] = {
        meanExtraCount: meanOf(rows, "extraCount"),
        rows,
        stampedQuestions,
        summary: summarizeRecallRows(rows),
        unanswerableRows,
        unanswerableSummary: { gateConfident: meanOf(unanswerableRows, "gateConfident") },
      };
      console.log(
        `${arm}: ${JSON.stringify(arms[arm].summary)} extra=${arms[arm].meanExtraCount} unanswerable=${JSON.stringify(arms[arm].unanswerableSummary)}`
      );
    }

    delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;

    const comparisons = {
      answerable: pairedRecallDeltas(arms.adapter.rows, arms.identity.rows),
      extraCount: pairedMeanDelta(arms.adapter.rows, arms.identity.rows, "extraCount"),
      unanswerable: pairedRecallDeltas(arms.adapter.unanswerableRows, arms.identity.unanswerableRows),
    };
    const report = {
      arms,
      comparisons,
      config: {
        adapter: {
          ...adapter,
          file: path.basename(adapterPath),
          selected: training?.selected ?? null,
          trainedOn: training ? `${training.corpus} (${training.trainQuestions} questions, ${training.heldOutQuestions} held out)` : null,
        },
        corpus: path.basename(corpusPath),
        documentPrefix: config.getEmbeddingDocumentPrefix(),
        embeddingModel: config.getEmbeddingModel(),
        queryPrefix: config.getEmbeddingQueryPrefix(),
        questions: cases.length,
        retrievalTopK: config.getRetrievalTopK(),
        route: ADAPTER_EVAL_ROUTE,
        runtime,
        seed,
        unanswerableQuestions: unanswerableCases.length,
        vectorScoreDrift,
      },
      decision: decideQueryAdapter(comparisons),
      generatedAt: new Date().toISOString(),
      reportType: "qasper-retrieval-query-adapter",
    };

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatAdapterReportMarkdown(report));
    process.stdout.write(formatAdapterReportMarkdown(report));

    if (vectorScoreDrift.drifted > 0) {
      console.error(`${vectorScoreDrift.drifted} dense-ranked chunk(s) carry another vectorScore with the adapter on.`);
      process.exitCode = 1;
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
