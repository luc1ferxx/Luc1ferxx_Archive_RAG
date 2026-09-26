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
// adds paired bootstrap 95% CIs for this run minus the other.
//
// Usage (real embeddings, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
//   node evaluation/run-qasper-retrieval-eval.mjs
//     [--corpus evaluation/generated/qasper-train.json] [--cases 400] [--seed 1]
//     [--latest-name latest-qasper-retrieval] [--compare <report.json>]

import "dotenv/config";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sampleQasperCases } from "./run-qasper-answer-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

export const RECALL_METRICS = Object.freeze(["hitAt1", "hitAt3", "hitAtAll", "admitted"]);
// With --context-floors: whether the gate was confident, and whether evidence
// reached the context selectQaContext builds at each extra-candidate floor.
export const CONTEXT_FLOORS = Object.freeze([0, 0.01, 0.3]);
const contextMetric = (floor) => `context@${floor}`;

const round = (value) => (value === null ? null : Number(value.toFixed(4)));
const mean = (values) =>
  values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);

/** rows: { hitAt1, hitAt3, hitAtAll, admitted } booleans per question. */
const metricsOf = (rows) => [
  ...RECALL_METRICS,
  ...["gateConfident", ...CONTEXT_FLOORS.map(contextMetric)].filter((metric) =>
    rows.some((row) => metric in row)
  ),
];

export const summarizeRecallRows = (rows) =>
  Object.fromEntries(metricsOf(rows).map((metric) => [metric, mean(rows.map((row) => (row[metric] ? 1 : 0)))]));

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

/**
 * Paired bootstrap of this run minus the other over the questions both ran:
 * resamples questions, so a question's two outcomes stay together.
 */
export const pairedRecallDeltas = (rows, otherRows, { iterations = 4000, seed = 1 } = {}) => {
  const other = new Map(otherRows.map((row) => [row.id, row]));
  const pairs = rows.filter((row) => other.has(row.id)).map((row) => [row, other.get(row.id)]);
  const random = createSeededRandom(seed);

  return {
    cases: pairs.length,
    ...Object.fromEntries(
      metricsOf(rows).map((metric) => {
        const diffs = pairs.map(([left, right]) => (left[metric] ? 1 : 0) - (right[metric] ? 1 : 0));
        const samples = [];

        for (let index = 0; index < iterations; index += 1) {
          let sum = 0;

          for (let draw = 0; draw < diffs.length; draw += 1) {
            sum += diffs[Math.floor(random() * diffs.length)];
          }

          samples.push(sum / Math.max(1, diffs.length));
        }

        samples.sort((left, right) => left - right);

        return [
          metric,
          {
            delta: mean(diffs),
            ci95: diffs.length === 0
              ? null
              : [round(samples[Math.floor(iterations * 0.025)]), round(samples[Math.floor(iterations * 0.975)])],
          },
        ];
      })
    ),
  };
};

const formatMarkdown = (report) => {
  const { summary, config, comparison } = report;
  const lines = [
    "# QASPER evidence recall (single-document QA route)",
    "",
    `Generated ${report.generatedAt}; corpus \`${config.corpus}\`; ${report.rows.length} answerable questions, seed ${config.seed}; embedding ${config.embeddingModel} (query prefix ${JSON.stringify(config.queryPrefix)}, document prefix ${JSON.stringify(config.documentPrefix)}); retrieval top-K ${config.retrievalTopK}.`,
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
  ];

  if (comparison) {
    lines.push(
      "",
      `Paired against \`${comparison.against}\` (${comparison.cases} questions; this run minus that one, bootstrap 95% CI):`,
      "",
      "| Metric | Delta | 95% CI |",
      "|---|---|---|",
      ...Object.keys(comparison)
        .filter((metric) => comparison[metric]?.ci95 !== undefined)
        .map((metric) => `| ${metric} | ${comparison[metric].delta} | [${comparison[metric].ci95?.join(", ")}] |`)
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
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

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

  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");
  process.env.DOCCOMPARE_STANDALONE = "1";

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
  const { assessQaConfidence, selectQaContext } = await import("../rag/confidence.js");
  const config = await import("../rag/config.js");
  const rows = [];

  try {
    await rag.initializeDocumentRegistry();
    await mkdir(path.join(tempRoot, "sources"), { recursive: true });
    console.log(`Ingesting ${documents.length} papers for ${cases.length} questions...`);

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

    // Same fallbacks as citations.js reads a page number with.
    const pageOf = (result) => {
      const metadata = result?.document?.metadata ?? {};

      return Number(metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page);
    };

    for (const [index, testCase] of cases.entries()) {
      const expected = new Set(testCase.expectedEvidence[0].pages);
      const { evidenceRequirementCount, results } = await retrieveQaCandidates({
        docIds: [testCase.docKeys[0]],
        resolvedQuery: testCase.question,
      });
      const hitRank = results.findIndex((result) => expected.has(pageOf(result)));
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
        candidateCount: results.length,
        hitAt1: hitRank === 0,
        hitAt3: hitRank >= 0 && hitRank < 3,
        hitAtAll: hitRank >= 0,
        hitRank: hitRank >= 0 ? hitRank + 1 : null,
        id: testCase.id,
      });

      if ((index + 1) % 100 === 0) {
        console.log(`retrieved ${index + 1}/${cases.length}`);
      }
    }

    const other = comparePath ? JSON.parse(await readFile(path.resolve(process.cwd(), comparePath), "utf8")) : null;
    const report = {
      comparison: other
        ? { against: path.basename(comparePath), ...pairedRecallDeltas(rows, other.rows ?? []) }
        : null,
      config: {
        cases: caseCount,
        corpus: path.basename(corpusPath),
        documentPrefix: config.getEmbeddingDocumentPrefix(),
        embeddingModel: config.getEmbeddingModel(),
        queryPrefix: config.getEmbeddingQueryPrefix(),
        retrievalTopK: config.getRetrievalTopK(),
        seed,
      },
      generatedAt: new Date().toISOString(),
      reportType: "qasper-retrieval",
      rows,
      summary: summarizeRecallRows(rows),
    };

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatMarkdown(report));
    process.stdout.write(formatMarkdown(report));
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
