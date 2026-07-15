import "dotenv/config";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ingestDocumentPages } from "../chat.js";
import {
  getComparisonTopKPerDoc,
  getRerankProvider,
  getRerankWeight,
  getRetrievalTopK,
} from "../rag/config.js";
import { getResultKey } from "../rag/citations.js";
import { resetDocumentRegistry } from "../rag/doc-registry.js";
import { configureOpenAIProvider, embedQuery, resetOpenAIProvider } from "../rag/openai.js";
import { rerankResultsWithProvider } from "../rag/reranker.js";
import { resetSessionMemory } from "../rag/memory.js";
import { MODEL_ROUTE_IDS } from "../rag/model-providers/schema.js";
import { configureRagDataDirectory } from "../rag/storage.js";
import { buildTermSet } from "../rag/text-utils.js";
import { resetVectorStore, searchDocuments } from "../rag/vector-store.js";
import {
  attachEvaluationEvidence,
  getCorpusIdentity,
  getEvaluationSuiteContext,
  resolveEvaluationProfile,
  toRepoRelativePath,
} from "./eval-evidence.js";
import { configureEvaluationStores } from "./eval-store-overrides.js";
import { robustEvalSuite } from "./eval-suite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resultsDirectory = path.join(__dirname, "results");
const generatedDirectory = path.join(__dirname, "generated");
const defaultCorpusPath = path.join(__dirname, "synthetic-corpus-near-duplicate.json");
const embeddingDimensions = 64;

const toRunId = () => new Date().toISOString().replace(/[:.]/g, "-");

const round = (value, precision = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(precision)) : null;

const ratio = (numerator, denominator) =>
  denominator > 0 ? round(numerator / denominator) : null;

const average = (values) => {
  const safeValues = values.filter((value) => Number.isFinite(value));

  if (safeValues.length === 0) {
    return null;
  }

  return round(safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length);
};

const hashToken = (token) => {
  let hash = 0;

  for (const character of token) {
    hash = (hash * 31 + character.codePointAt(0)) % embeddingDimensions;
  }

  return hash;
};

const toDeterministicEmbedding = (text) => {
  const vector = new Array(embeddingDimensions).fill(0);

  for (const term of buildTermSet(text)) {
    vector[hashToken(term)] += 1;
  }

  return vector;
};

const configureDeterministicEmbeddingProvider = () => {
  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map((text) => toDeterministicEmbedding(text)),
    embedQuery: async (query) => toDeterministicEmbedding(query),
  });
};

const parseArgs = (argv) => {
  const args = {
    positional: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (!rawArg.startsWith("--")) {
      args.positional.push(rawArg);
      continue;
    }

    const [key, inlineValue] = rawArg.slice(2).split("=", 2);
    const nextValue = argv[index + 1];

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      args[key] = nextValue;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
};

const toPositiveInteger = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
};

const toChoice = (value, fallbackValue, allowedValues, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (!allowedValues.includes(normalizedValue)) {
    throw new Error(`${name} must be one of: ${allowedValues.join(", ")}.`);
  }

  return normalizedValue;
};

const toUnitNumber = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 1) {
    throw new Error(`${name} must be a number between 0 and 1.`);
  }

  return parsedValue;
};

const getLatestName = (value) => {
  const latestName = String(value ?? "latest-rerank");

  if (!/^[A-Za-z0-9._-]+$/.test(latestName)) {
    throw new Error("--latest-name must contain only letters, numbers, dots, underscores, or hyphens.");
  }

  return latestName;
};

const resolveCorpusPath = (requestedPath) =>
  path.resolve(process.cwd(), requestedPath ?? defaultCorpusPath);

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const findRobustReport = ({ corpusPath, latestName }) =>
  robustEvalSuite.reports.find(
    (report) =>
      report.reportType === "rerank" &&
      report.latestName === latestName &&
      path.resolve(__dirname, "..", report.corpusPath) === corpusPath
  ) ?? null;

const buildExpectedUnits = (expectedEvidence = []) => {
  const units = [];

  for (const expected of expectedEvidence ?? []) {
    const docKey = String(expected?.docKey ?? "").trim();

    if (!docKey) {
      continue;
    }

    const pages = Array.isArray(expected.pages)
      ? expected.pages
          .map((page) => Number(page))
          .filter((page) => Number.isFinite(page) && page > 0)
      : [];

    if (pages.length === 0) {
      units.push({
        key: `${docKey}:*`,
        docKey,
        pageNumber: null,
      });
      continue;
    }

    for (const pageNumber of pages) {
      units.push({
        key: `${docKey}:${pageNumber}`,
        docKey,
        pageNumber,
      });
    }
  }

  return units;
};

const getResultDocKey = (result, docKeyByDocId) =>
  docKeyByDocId.get(result?.document?.metadata?.docId) ?? null;

const getResultPageNumber = (result) => {
  const pageNumber = Number(result?.document?.metadata?.pageNumber);

  return Number.isFinite(pageNumber) ? pageNumber : null;
};

const getRelevance = ({ result, expectedUnits, docKeyByDocId }) => {
  const docKey = getResultDocKey(result, docKeyByDocId);
  const pageNumber = getResultPageNumber(result);

  if (!docKey) {
    return {
      exactRelevant: false,
      relevanceGrade: 0,
      matchedUnitKey: null,
    };
  }

  const exactUnit = expectedUnits.find(
    (unit) =>
      unit.docKey === docKey &&
      (unit.pageNumber === null || unit.pageNumber === pageNumber)
  );

  if (exactUnit) {
    return {
      exactRelevant: true,
      relevanceGrade: 2,
      matchedUnitKey: exactUnit.key,
    };
  }

  return {
    exactRelevant: false,
    relevanceGrade: 0,
    matchedUnitKey: null,
  };
};

const dcg = (grades, k) =>
  grades
    .slice(0, k)
    .reduce(
      (sum, grade, index) =>
        sum + (2 ** grade - 1) / Math.log2(index + 2),
      0
    );

const idealDcg = (expectedUnits, k) =>
  dcg(
    expectedUnits.map(() => 2),
    k
  );

const labelRankingForMetrics = ({ ranking = [], expectedUnits, docKeyByDocId }) => {
  const matchedUnitKeys = new Set();

  return ranking.map((result) => {
    const relevance = getRelevance({
      result,
      expectedUnits,
      docKeyByDocId,
    });

    if (!relevance.exactRelevant) {
      return relevance;
    }

    if (matchedUnitKeys.has(relevance.matchedUnitKey)) {
      return {
        ...relevance,
        exactRelevant: false,
        relevanceGrade: 0,
        duplicateRelevantUnit: true,
      };
    }

    matchedUnitKeys.add(relevance.matchedUnitKey);
    return relevance;
  });
};

export const calculateRankingMetrics = ({
  ranking = [],
  expectedUnits = [],
  docKeyByDocId = new Map(),
  k,
} = {}) => {
  const safeK = Math.max(0, Math.floor(Number(k) || 0));
  const topRanking = ranking.slice(0, safeK);
  const labeledTopRanking = labelRankingForMetrics({
    ranking: topRanking,
    expectedUnits,
    docKeyByDocId,
  });
  const relevantTopResults = labeledTopRanking.filter((entry) => entry.exactRelevant);
  const matchedUnits = new Set(
    labeledTopRanking
      .map((entry) => entry.matchedUnitKey)
      .filter(Boolean)
  );
  const firstRelevantIndex = labeledTopRanking.findIndex(
    (entry) => entry.exactRelevant
  );
  const topCount = topRanking.length;
  const relevantCount = relevantTopResults.length;
  const noiseCount = Math.max(0, topCount - relevantCount);
  const maxDcg = idealDcg(expectedUnits, safeK);
  const actualDcg = dcg(
    labeledTopRanking.map((entry) => entry.relevanceGrade),
    safeK
  );

  return {
    ndcgAtK: maxDcg > 0 ? round(actualDcg / maxDcg) : null,
    precisionAtK: topCount > 0 ? round(relevantCount / topCount) : null,
    recallAtK: expectedUnits.length > 0
      ? round(matchedUnits.size / expectedUnits.length)
      : null,
    mrr: firstRelevantIndex >= 0 ? round(1 / (firstRelevantIndex + 1)) : 0,
    noiseRateAtK: topCount > 0 ? round(noiseCount / topCount) : null,
    relevantCountAtK: relevantCount,
    noiseCountAtK: noiseCount,
    expectedRelevantCount: expectedUnits.length,
    evaluatedCountAtK: topCount,
  };
};

const calculateNoiseFilteringRate = ({
  baselineRanking = [],
  rerankedRanking = [],
  expectedUnits,
  docKeyByDocId,
  k,
}) => {
  const baselineTopRanking = baselineRanking.slice(0, k);
  const baselineLabels = labelRankingForMetrics({
    ranking: baselineTopRanking,
    expectedUnits,
    docKeyByDocId,
  });
  const baselineNoiseKeys = baselineTopRanking
    .filter((_result, index) => !baselineLabels[index].exactRelevant)
    .map((result) => getResultKey(result));
  const rerankedKeys = new Set(rerankedRanking.slice(0, k).map((result) => getResultKey(result)));

  if (baselineNoiseKeys.length === 0) {
    return null;
  }

  const removedNoiseCount = baselineNoiseKeys.filter(
    (resultKey) => !rerankedKeys.has(resultKey)
  ).length;

  return round(removedNoiseCount / baselineNoiseKeys.length);
};

const calculateMetricLift = (baselineMetrics, rerankedMetrics) => {
  const lift = {};

  for (const key of ["ndcgAtK", "precisionAtK", "recallAtK", "mrr"]) {
    const baselineValue = baselineMetrics?.[key];
    const rerankedValue = rerankedMetrics?.[key];
    const absolute = Number.isFinite(baselineValue) && Number.isFinite(rerankedValue)
      ? round(rerankedValue - baselineValue)
      : null;

    lift[key] = {
      absolute,
      relative: absolute !== null && baselineValue > 0
        ? round(absolute / baselineValue)
        : null,
    };
  }

  const baselineNoiseRate = baselineMetrics?.noiseRateAtK;
  const rerankedNoiseRate = rerankedMetrics?.noiseRateAtK;

  lift.noiseRateAtK = {
    absoluteReduction:
      Number.isFinite(baselineNoiseRate) && Number.isFinite(rerankedNoiseRate)
        ? round(baselineNoiseRate - rerankedNoiseRate)
        : null,
    relativeReduction:
      Number.isFinite(baselineNoiseRate) && baselineNoiseRate > 0 && Number.isFinite(rerankedNoiseRate)
        ? round((baselineNoiseRate - rerankedNoiseRate) / baselineNoiseRate)
        : null,
  };

  return lift;
};

const summarizeResult = ({ result, docKeyByDocId, expectedUnits, rank }) => {
  const relevance = getRelevance({
    result,
    expectedUnits,
    docKeyByDocId,
  });

  return {
    rank,
    resultKey: getResultKey(result),
    docKey: getResultDocKey(result, docKeyByDocId),
    pageNumber: getResultPageNumber(result),
    chunkIndex: result?.document?.metadata?.chunkIndex ?? null,
    fileName: result?.document?.metadata?.fileName ?? null,
    score: round(Number(result?.score), 6),
    originalScore: round(Number(result?.originalScore), 6),
    rerankScore: round(Number(result?.rerankScore), 6),
    vectorScore: round(Number(result?.vectorScore), 6),
    keywordScore: round(Number(result?.keywordScore), 6),
    relevanceGrade: relevance.relevanceGrade,
    relevant: relevance.exactRelevant,
  };
};

const averageMetrics = (entries) => {
  const metrics = {};

  for (const key of [
    "ndcgAtK",
    "precisionAtK",
    "recallAtK",
    "mrr",
    "noiseRateAtK",
    "relevantCountAtK",
    "noiseCountAtK",
    "expectedRelevantCount",
    "evaluatedCountAtK",
  ]) {
    metrics[key] = average(entries.map((entry) => entry?.[key]));
  }

  return metrics;
};

const buildComparisonCaseResult = async ({
  testCase,
  docIdByKey,
  docKeyByDocId,
  topKPerDoc,
  candidateMultiplier,
}) => {
  const queryVector = await embedQuery(testCase.question);
  const perDocument = [];
  const startedAt = performance.now();

  for (const docKey of testCase.docKeys) {
    const docId = docIdByKey.get(docKey);
    const expectedUnits = buildExpectedUnits(
      (testCase.expectedEvidence ?? []).filter((entry) => entry.docKey === docKey)
    );

    if (!docId || expectedUnits.length === 0) {
      continue;
    }

    const candidates = await searchDocuments({
      queryVector,
      queryText: testCase.question,
      docIds: [docId],
      topK: topKPerDoc * candidateMultiplier,
    });
    const baselineRanking = candidates.slice(0, topKPerDoc);
    const rerankedRanking = await rerankResultsWithProvider({
      queryText: testCase.question,
      results: candidates,
      topK: topKPerDoc,
    });
    const baselineMetrics = calculateRankingMetrics({
      ranking: baselineRanking,
      expectedUnits,
      docKeyByDocId,
      k: topKPerDoc,
    });
    const rerankedMetrics = calculateRankingMetrics({
      ranking: rerankedRanking,
      expectedUnits,
      docKeyByDocId,
      k: topKPerDoc,
    });

    perDocument.push({
      docKey,
      candidateCount: candidates.length,
      k: topKPerDoc,
      expectedUnits,
      baselineMetrics,
      rerankedMetrics,
      lift: calculateMetricLift(baselineMetrics, rerankedMetrics),
      noiseFilteringRate: calculateNoiseFilteringRate({
        baselineRanking,
        rerankedRanking,
        expectedUnits,
        docKeyByDocId,
        k: topKPerDoc,
      }),
      baselineRanking: baselineRanking.map((result, index) =>
        summarizeResult({
          result,
          docKeyByDocId,
          expectedUnits,
          rank: index + 1,
        })
      ),
      rerankedRanking: rerankedRanking.map((result, index) =>
        summarizeResult({
          result,
          docKeyByDocId,
          expectedUnits,
          rank: index + 1,
        })
      ),
    });
  }

  const baselineMetrics = averageMetrics(
    perDocument.map((entry) => entry.baselineMetrics)
  );
  const rerankedMetrics = averageMetrics(
    perDocument.map((entry) => entry.rerankedMetrics)
  );

  return {
    id: testCase.id,
    type: testCase.type,
    retrievalMode: "per-document",
    question: testCase.question,
    docKeys: testCase.docKeys,
    k: topKPerDoc,
    candidateCount: perDocument.reduce(
      (sum, entry) => sum + entry.candidateCount,
      0
    ),
    expectedUnits: buildExpectedUnits(testCase.expectedEvidence),
    responseTimeMs: Math.round(performance.now() - startedAt),
    baselineMetrics,
    rerankedMetrics,
    lift: calculateMetricLift(baselineMetrics, rerankedMetrics),
    noiseFilteringRate: average(
      perDocument.map((entry) => entry.noiseFilteringRate)
    ),
    perDocument,
  };
};

const buildGlobalCaseResult = async ({
  testCase,
  docIdByKey,
  docKeyByDocId,
  topK,
  candidateMultiplier,
}) => {
  const queryVector = await embedQuery(testCase.question);
  const docIds = testCase.docKeys.map((docKey) => docIdByKey.get(docKey)).filter(Boolean);
  const expectedUnits = buildExpectedUnits(testCase.expectedEvidence);
  const startedAt = performance.now();
  const candidates = await searchDocuments({
    queryVector,
    queryText: testCase.question,
    docIds,
    topK: topK * candidateMultiplier,
  });
  const baselineRanking = candidates.slice(0, topK);
  const rerankedRanking = await rerankResultsWithProvider({
    queryText: testCase.question,
    results: candidates,
    topK,
  });
  const baselineMetrics = calculateRankingMetrics({
    ranking: baselineRanking,
    expectedUnits,
    docKeyByDocId,
    k: topK,
  });
  const rerankedMetrics = calculateRankingMetrics({
    ranking: rerankedRanking,
    expectedUnits,
    docKeyByDocId,
    k: topK,
  });

  return {
    id: testCase.id,
    type: testCase.type,
    retrievalMode: "global",
    question: testCase.question,
    docKeys: testCase.docKeys,
    k: topK,
    candidateCount: candidates.length,
    expectedUnits,
    responseTimeMs: Math.round(performance.now() - startedAt),
    baselineMetrics,
    rerankedMetrics,
    lift: calculateMetricLift(baselineMetrics, rerankedMetrics),
    noiseFilteringRate: calculateNoiseFilteringRate({
      baselineRanking,
      rerankedRanking,
      expectedUnits,
      docKeyByDocId,
      k: topK,
    }),
    baselineRanking: baselineRanking.map((result, index) =>
      summarizeResult({
        result,
        docKeyByDocId,
        expectedUnits,
        rank: index + 1,
      })
    ),
    rerankedRanking: rerankedRanking.map((result, index) =>
      summarizeResult({
        result,
        docKeyByDocId,
        expectedUnits,
        rank: index + 1,
      })
    ),
  };
};

const buildSummaryMetrics = (caseResults) => {
  const baseline = averageMetrics(caseResults.map((caseResult) => caseResult.baselineMetrics));
  const reranked = averageMetrics(caseResults.map((caseResult) => caseResult.rerankedMetrics));

  return {
    baseline,
    reranked,
    lift: calculateMetricLift(baseline, reranked),
    noiseFilteringRate: average(caseResults.map((caseResult) => caseResult.noiseFilteringRate)),
    averageCandidateCount: average(caseResults.map((caseResult) => caseResult.candidateCount)),
    averageResponseTimeMs: average(caseResults.map((caseResult) => caseResult.responseTimeMs)),
  };
};

const renderPercent = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";

const renderNumber = (value) =>
  Number.isFinite(value) ? value.toFixed(4) : "N/A";

const renderLift = (entry, key) => {
  const lift = entry?.[key];

  if (!lift) {
    return "N/A";
  }

  return `${renderNumber(lift.absolute)} (${renderPercent(lift.relative)})`;
};

const renderNoiseLift = (entry) => {
  const lift = entry?.noiseRateAtK;

  if (!lift) {
    return "N/A";
  }

  return `${renderNumber(lift.absoluteReduction)} (${renderPercent(lift.relativeReduction)})`;
};

const buildMarkdownReport = ({ runId, corpusPath, summary, caseResults }) => {
  const lines = [
    "# Offline Rerank Evaluation",
    "",
    `- Run ID: \`${runId}\``,
    `- Corpus file: \`${corpusPath}\``,
    `- Ranking cases: \`${summary.caseCount}\``,
    `- QA top-k: \`${summary.config.topK}\``,
    `- Compare top-k per doc: \`${summary.config.topKPerDoc}\``,
    `- Candidate multiplier: \`${summary.config.candidateMultiplier}\``,
    `- Embedding provider: \`${summary.config.embeddingProvider}\``,
    `- Rerank provider: \`${summary.config.rerankProvider}\``,
    `- Rerank weight: \`${summary.config.rerankWeight}\``,
    "",
    "## Summary",
    "",
    "| Metric | Baseline | Rerank | Lift |",
    "| --- | ---: | ---: | ---: |",
    `| NDCG@k | ${renderNumber(summary.metrics.baseline.ndcgAtK)} | ${renderNumber(summary.metrics.reranked.ndcgAtK)} | ${renderLift(summary.metrics.lift, "ndcgAtK")} |`,
    `| Precision@k | ${renderNumber(summary.metrics.baseline.precisionAtK)} | ${renderNumber(summary.metrics.reranked.precisionAtK)} | ${renderLift(summary.metrics.lift, "precisionAtK")} |`,
    `| Recall@k | ${renderNumber(summary.metrics.baseline.recallAtK)} | ${renderNumber(summary.metrics.reranked.recallAtK)} | ${renderLift(summary.metrics.lift, "recallAtK")} |`,
    `| MRR | ${renderNumber(summary.metrics.baseline.mrr)} | ${renderNumber(summary.metrics.reranked.mrr)} | ${renderLift(summary.metrics.lift, "mrr")} |`,
    `| Noise rate@k | ${renderNumber(summary.metrics.baseline.noiseRateAtK)} | ${renderNumber(summary.metrics.reranked.noiseRateAtK)} | ${renderNoiseLift(summary.metrics.lift)} lower is better |`,
    `| Baseline noise filtered | N/A | ${renderNumber(summary.metrics.noiseFilteringRate)} | N/A |`,
    "",
    "## Case Results",
    "",
    "| Case | Type | Mode | NDCG baseline/rerank | P baseline/rerank | R baseline/rerank | MRR baseline/rerank | Noise filtered |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const caseResult of caseResults) {
    lines.push(
      `| ${caseResult.id} | ${caseResult.type} | ${caseResult.retrievalMode} | ${renderNumber(caseResult.baselineMetrics.ndcgAtK)} / ${renderNumber(caseResult.rerankedMetrics.ndcgAtK)} | ${renderNumber(caseResult.baselineMetrics.precisionAtK)} / ${renderNumber(caseResult.rerankedMetrics.precisionAtK)} | ${renderNumber(caseResult.baselineMetrics.recallAtK)} / ${renderNumber(caseResult.rerankedMetrics.recallAtK)} | ${renderNumber(caseResult.baselineMetrics.mrr)} / ${renderNumber(caseResult.rerankedMetrics.mrr)} | ${renderNumber(caseResult.noiseFilteringRate)} |`
    );
  }

  return `${lines.join("\n")}\n`;
};

const setupEvaluationCorpus = async ({ corpus, runDirectory }) => {
  const sourceDirectory = path.join(runDirectory, "sources");
  const docIdByKey = new Map();
  const docKeyByDocId = new Map();

  await mkdir(sourceDirectory, { recursive: true });

  for (const documentSpec of corpus.documents ?? []) {
    const docId = randomUUID();
    const sourcePath = path.join(sourceDirectory, `${documentSpec.key}.txt`);

    await writeFile(sourcePath, (documentSpec.pages ?? []).join("\n\n"), "utf8");
    await ingestDocumentPages({
      docId,
      filePath: sourcePath,
      fileName: documentSpec.fileName,
      pages: (documentSpec.pages ?? []).map((text, index) => ({
        pageNumber: index + 1,
        text,
      })),
    });

    docIdByKey.set(documentSpec.key, docId);
    docKeyByDocId.set(docId, documentSpec.key);
  }

  return {
    docIdByKey,
    docKeyByDocId,
  };
};

export const runRerankEvaluation = async ({
  corpusPath,
  latestName = "latest-rerank",
  topK = getRetrievalTopK(),
  topKPerDoc = getComparisonTopKPerDoc(),
  candidateMultiplier = 3,
  embeddingProvider = "deterministic",
  rerankProvider,
  rerankWeight,
  crossEncoderEndpoint,
  crossEncoderModel,
} = {}) => {
  const runId = toRunId();
  const runDirectory = path.join(generatedDirectory, runId);
  const latestJsonPath = path.join(resultsDirectory, `${latestName}.json`);
  const latestMarkdownPath = path.join(resultsDirectory, `${latestName}.md`);
  const runJsonPath = path.join(resultsDirectory, `${runId}-rerank.json`);
  const runMarkdownPath = path.join(resultsDirectory, `${runId}-rerank.md`);
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const corpusIdentity = getCorpusIdentity({
    corpus,
    corpusPath,
  });

  await mkdir(resultsDirectory, { recursive: true });
  await mkdir(runDirectory, { recursive: true });

  process.env.RAG_RERANK_ENABLED = "true";
  process.env.RAG_RERANK_PROVIDER = rerankProvider ?? process.env.RAG_RERANK_PROVIDER ?? "heuristic";
  if (rerankWeight !== undefined) {
    process.env.RAG_RERANK_WEIGHT = String(rerankWeight);
  }
  if (crossEncoderEndpoint !== undefined) {
    process.env.RAG_CROSS_ENCODER_ENDPOINT = crossEncoderEndpoint;
  }
  if (crossEncoderModel !== undefined) {
    process.env.RAG_CROSS_ENCODER_MODEL = crossEncoderModel;
  }
  process.env.VECTOR_STORE_PROVIDER = process.env.VECTOR_STORE_PROVIDER || "local";

  configureEvaluationStores();
  configureRagDataDirectory(path.join(runDirectory, "rag-data"));
  await resetDocumentRegistry();
  resetVectorStore();
  resetSessionMemory();

  if (embeddingProvider === "deterministic") {
    configureDeterministicEmbeddingProvider();
  }

  try {
    const { docIdByKey, docKeyByDocId } = await setupEvaluationCorpus({
      corpus,
      runDirectory,
    });
    const skippedCases = [];
    const caseResults = [];

    for (const testCase of corpus.cases ?? []) {
      if (testCase.shouldAbstain) {
        skippedCases.push({
          id: testCase.id,
          reason: "abstain_case",
        });
        continue;
      }

      const expectedUnits = buildExpectedUnits(testCase.expectedEvidence);

      if (expectedUnits.length === 0) {
        skippedCases.push({
          id: testCase.id,
          reason: "no_expected_evidence",
        });
        continue;
      }

      if (testCase.type === "compare" && (testCase.docKeys ?? []).length > 1) {
        caseResults.push(
          await buildComparisonCaseResult({
            testCase,
            docIdByKey,
            docKeyByDocId,
            topKPerDoc,
            candidateMultiplier,
          })
        );
      } else {
        caseResults.push(
          await buildGlobalCaseResult({
            testCase,
            docIdByKey,
            docKeyByDocId,
            topK,
            candidateMultiplier,
          })
        );
      }
    }

    const summary = {
      runId,
      createdAt: new Date().toISOString(),
      corpus: {
        path: toRepoRelativePath(corpusPath),
        documents: corpus.documents?.length ?? 0,
        cases: corpus.cases?.length ?? 0,
      },
      caseCount: caseResults.length,
      skippedCaseCount: skippedCases.length,
      config: {
        topK,
        topKPerDoc,
        candidateMultiplier,
        embeddingProvider,
        rerankProvider: getRerankProvider(),
        rerankWeight: getRerankWeight(),
      },
      metrics: buildSummaryMetrics(caseResults),
    };
    const baseReport = {
      summary,
      skippedCases,
      cases: caseResults,
    };
    const robustReport = findRobustReport({
      corpusPath,
      latestName,
    });
    const report = await attachEvaluationEvidence(baseReport, {
      command: "npm run eval:rerank",
      corpus: {
        ...corpusIdentity,
        path: corpusPath,
      },
      modelRouteId:
        getRerankProvider() === "cross-encoder"
          ? MODEL_ROUTE_IDS.rerankCrossEncoderDefault
          : null,
      profile: resolveEvaluationProfile(robustReport ? "robust" : "default"),
      provider: {
        id: "rerank",
        mode: getRerankProvider(),
      },
      reportId: robustReport?.id ?? `rerank-${latestName}`,
      reportType: "rerank",
      suite: getEvaluationSuiteContext(),
    });
    const markdownReport = buildMarkdownReport({
      runId,
      corpusPath: summary.corpus.path,
      summary,
      caseResults,
    });

    await writeJson(runJsonPath, report);
    await writeJson(latestJsonPath, report);
    await writeFile(runMarkdownPath, markdownReport, "utf8");
    await writeFile(latestMarkdownPath, markdownReport, "utf8");

    return {
      runId,
      runJsonPath,
      runMarkdownPath,
      latestJsonPath,
      latestMarkdownPath,
      summary,
    };
  } finally {
    if (embeddingProvider === "deterministic") {
      resetOpenAIProvider();
    }
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = resolveCorpusPath(args.positional[0]);
  const topK = toPositiveInteger(args["top-k"], getRetrievalTopK(), "--top-k");
  const topKPerDoc = toPositiveInteger(
    args["top-k-per-doc"],
    getComparisonTopKPerDoc(),
    "--top-k-per-doc"
  );
  const candidateMultiplier = toPositiveInteger(
    args["candidate-multiplier"],
    3,
    "--candidate-multiplier"
  );
  const embeddingProvider = toChoice(
    args["embedding-provider"],
    "deterministic",
    ["deterministic", "openai"],
    "--embedding-provider"
  );
  const rerankProvider = toChoice(
    args["rerank-provider"],
    undefined,
    ["heuristic", "cross-encoder"],
    "--rerank-provider"
  );
  const rerankWeight = toUnitNumber(
    args["rerank-weight"],
    undefined,
    "--rerank-weight"
  );
  const latestName = getLatestName(args["latest-name"]);
  const result = await runRerankEvaluation({
    corpusPath,
    latestName,
    topK,
    topKPerDoc,
    candidateMultiplier,
    embeddingProvider,
    rerankProvider,
    rerankWeight,
    crossEncoderEndpoint: args["cross-encoder-endpoint"],
    crossEncoderModel: args["cross-encoder-model"],
  });

  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        latestJsonPath: result.latestJsonPath,
        latestMarkdownPath: result.latestMarkdownPath,
        metrics: result.summary.metrics,
      },
      null,
      2
    )
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
