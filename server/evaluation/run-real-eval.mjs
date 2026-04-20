import "dotenv/config";
import { performance } from "perf_hooks";
import { randomUUID } from "crypto";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import chat, { ingestDocument } from "../chat.js";
import {
  getChatModel,
  getChunkOverlap,
  getChunkStrategy,
  getChunkSize,
  getComparisonTopKPerDoc,
  getEmbeddingModel,
  getMaxComparisonSources,
  getMinRelevanceScore,
  isNearDuplicateGuardEnabled,
  getRetrievalTopK,
} from "../rag/config.js";
import { resetDocumentRegistry } from "../rag/doc-registry.js";
import { resetSessionMemory } from "../rag/memory.js";
import { configureRagDataDirectory } from "../rag/storage.js";
import { resetVectorStore } from "../rag/vector-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resultsDirectory = path.join(__dirname, "results");
const generatedDirectory = path.join(__dirname, "generated");
const defaultCorpusPath = path.join(__dirname, "real-corpus.json");
const abstainPatterns = [
  "couldn't find enough grounded evidence",
  "comparison would be unreliable",
  "selected documents, so the comparison would be unreliable",
  "uploaded documents to answer reliably",
];

const toRunId = () => new Date().toISOString().replace(/[:.]/g, "-");

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const detectAbstain = (text) => {
  const normalizedText = String(text ?? "").toLowerCase();

  return abstainPatterns.some((pattern) => normalizedText.includes(pattern));
};

const getResponseAbstained = (response) =>
  typeof response?.abstained === "boolean"
    ? response.abstained
    : detectAbstain(response?.text);

const normalizeAnswerForMatch = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

const evaluateAnswerExpectation = ({ answer, expectedAnswerIncludes }) => {
  if (!Array.isArray(expectedAnswerIncludes) || expectedAnswerIncludes.length === 0) {
    return true;
  }

  const normalizedAnswer = normalizeAnswerForMatch(answer);

  return expectedAnswerIncludes.every((expectedFragment) =>
    normalizedAnswer.includes(normalizeAnswerForMatch(expectedFragment))
  );
};

const summarizeCitations = (citations, docKeyByDocId) =>
  citations.map((citation) => ({
    rank: citation.rank,
    docId: citation.docId,
    docKey: docKeyByDocId.get(citation.docId) ?? null,
    fileName: citation.fileName,
    pageNumber: citation.pageNumber,
    score: citation.score,
    sectionHeading: citation.sectionHeading,
  }));

const evaluateExpectedCoverage = ({ citations, expectedEvidence }) => {
  if (!expectedEvidence || expectedEvidence.length === 0) {
    return {
      docCoverageHit: citations.length === 0,
      pageCoverageHit: citations.length === 0,
    };
  }

  return {
    docCoverageHit: expectedEvidence.every((expected) =>
      citations.some((citation) => citation.docKey === expected.docKey)
    ),
    pageCoverageHit: expectedEvidence.every((expected) =>
      expected.pages.length === 0
        ? citations.some((citation) => citation.docKey === expected.docKey)
        : citations.some(
            (citation) =>
              citation.docKey === expected.docKey &&
              expected.pages.includes(citation.pageNumber)
          )
    ),
  };
};

const ratio = (numerator, denominator) =>
  denominator === 0 ? null : Number((numerator / denominator).toFixed(4));

const average = (values) =>
  values.length === 0
    ? null
    : Number(
        (
          values.reduce((sum, value) => sum + value, 0) / values.length
        ).toFixed(2)
      );

const evaluateCase = async ({ testCase, docIdByKey, docKeyByDocId }) => {
  const startedAt = performance.now();
  const response = await chat(
    testCase.docKeys.map((docKey) => docIdByKey.get(docKey)),
    testCase.question
  );
  const durationMs = Math.round(performance.now() - startedAt);
  const citations = summarizeCitations(response.citations ?? [], docKeyByDocId);
  const abstained = getResponseAbstained(response);
  const coverage = evaluateExpectedCoverage({
    citations,
    expectedEvidence: testCase.expectedEvidence,
  });
  const answerExpectationHit = evaluateAnswerExpectation({
    answer: response.text,
    expectedAnswerIncludes: testCase.expectedAnswerIncludes,
  });

  const passed = testCase.shouldAbstain
    ? abstained
    : !abstained &&
      coverage.docCoverageHit &&
      coverage.pageCoverageHit &&
      answerExpectationHit;

  return {
    id: testCase.id,
    type: testCase.type,
    question: testCase.question,
    docKeys: testCase.docKeys,
    shouldAbstain: testCase.shouldAbstain,
    abstained,
    abstainReason: response.abstainReason ?? (abstained ? response.text : null),
    docCoverageHit: coverage.docCoverageHit,
    pageCoverageHit: coverage.pageCoverageHit,
    answerExpectationHit,
    passed,
    responseTimeMs: durationMs,
    citationCount: citations.length,
    answer: response.text,
    citations,
  };
};

const buildMarkdownReport = ({ runId, corpusPath, summary, documentRecords, caseResults }) => {
  const lines = [
    "# Real RAG Evaluation",
    "",
    `- Run ID: \`${runId}\``,
    `- Corpus file: \`${corpusPath}\``,
    `- Embedding model: \`${summary.models.embedding}\``,
    `- Chat model: \`${summary.models.chat}\``,
    `- Chunk strategy: \`${summary.config.chunkStrategy}\``,
    `- Retrieval top-k: \`${summary.config.retrievalTopK}\``,
    `- Compare top-k per doc: \`${summary.config.compareTopKPerDoc}\``,
    `- Chunk size / overlap: \`${summary.config.chunkSize}/${summary.config.chunkOverlap}\``,
    `- Min relevance score: \`${summary.config.minRelevanceScore}\``,
    "",
    "## Documents",
    "",
    "| Doc Key | File | Pages | Chunks |",
    "| --- | --- | ---: | ---: |",
  ];

  for (const document of documentRecords) {
    lines.push(
      `| ${document.docKey} | ${document.fileName} | ${document.pageCount} | ${document.chunkCount} |`
    );
  }

  lines.push("", "## Metrics", "", "| Metric | Value |", "| --- | ---: |");
  lines.push(`| Overall pass rate | ${summary.metrics.overallPassRate} |`);
  lines.push(`| QA page hit rate | ${summary.metrics.qaPageHitRate} |`);
  lines.push(`| Compare doc coverage | ${summary.metrics.compareDocCoverageRate} |`);
  lines.push(`| Compare page hit rate | ${summary.metrics.comparePageHitRate} |`);
  lines.push(`| Abstain accuracy | ${summary.metrics.abstainAccuracy} |`);
  lines.push(`| Answer content hit rate | ${summary.metrics.answerContentHitRate} |`);
  lines.push(`| Avg response time (ms) | ${summary.metrics.averageResponseTimeMs} |`);
  lines.push(`| Avg citation count | ${summary.metrics.averageCitationCount} |`);

  lines.push(
    "",
    "## Case Results",
    "",
    "| Case | Type | Pass | Abstain | Doc Hit | Page Hit | Answer Hit | Time (ms) |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | ---: |");

  for (const caseResult of caseResults) {
    lines.push(
      `| ${caseResult.id} | ${caseResult.type} | ${caseResult.passed ? "yes" : "no"} | ${caseResult.abstained ? "yes" : "no"} | ${caseResult.docCoverageHit ? "yes" : "no"} | ${caseResult.pageCoverageHit ? "yes" : "no"} | ${caseResult.answerExpectationHit ? "yes" : "no"} | ${caseResult.responseTimeMs} |`
    );
  }

  const failedCases = caseResults.filter((caseResult) => !caseResult.passed);

  if (failedCases.length > 0) {
    lines.push("", "## Failures", "");

    for (const failedCase of failedCases) {
      lines.push(`### ${failedCase.id}`);
      lines.push("");
      lines.push(`- Question: ${failedCase.question}`);
      lines.push(`- Answer: ${failedCase.answer}`);
      lines.push(`- Answer hit: ${failedCase.answerExpectationHit ? "yes" : "no"}`);
      lines.push(
        `- Citations: ${failedCase.citations
          .map((citation) => `${citation.docKey ?? "unknown"} p.${citation.pageNumber}`)
          .join(", ")}`
      );
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
};

const resolveCorpusPath = () => {
  const requestedPath = process.argv[2] ?? defaultCorpusPath;
  return path.resolve(process.cwd(), requestedPath);
};

const main = async () => {
  const corpusPath = resolveCorpusPath();

  try {
    await access(corpusPath);
  } catch {
    throw new Error(
      `Real evaluation corpus not found at ${corpusPath}. Create it from evaluation/real-corpus.example.json or pass a custom path.`
    );
  }

  const runId = `real-${toRunId()}`;
  const runDirectory = path.join(generatedDirectory, runId);
  const ragDataDirectory = path.join(runDirectory, "rag-data");
  const resultsRunJsonPath = path.join(resultsDirectory, `${runId}.json`);
  const resultsRunMarkdownPath = path.join(resultsDirectory, `${runId}.md`);
  const latestJsonPath = path.join(resultsDirectory, "latest-real.json");
  const latestMarkdownPath = path.join(resultsDirectory, "latest-real.md");
  const corpusDirectory = path.dirname(corpusPath);
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

  await mkdir(resultsDirectory, { recursive: true });
  await mkdir(runDirectory, { recursive: true });

  configureRagDataDirectory(ragDataDirectory);
  resetDocumentRegistry();
  resetVectorStore();
  resetSessionMemory();

  const docIdByKey = new Map();
  const docKeyByDocId = new Map();
  const documentRecords = [];

  for (const documentSpec of corpus.documents ?? []) {
    const docId = randomUUID();
    const filePath = path.resolve(corpusDirectory, documentSpec.filePath);
    const documentRecord = await ingestDocument({
      docId,
      filePath,
      fileName: documentSpec.fileName ?? path.basename(filePath),
    });

    docIdByKey.set(documentSpec.key, docId);
    docKeyByDocId.set(docId, documentSpec.key);
    documentRecords.push({
      docKey: documentSpec.key,
      docId,
      fileName: documentRecord.fileName,
      filePath,
      pageCount: documentRecord.pageCount,
      chunkCount: documentRecord.chunkCount,
    });
  }

  const caseResults = [];

  for (const testCase of corpus.cases ?? []) {
    caseResults.push(
      await evaluateCase({
        testCase,
        docIdByKey,
        docKeyByDocId,
      })
    );
  }

  const qaCases = caseResults.filter(
    (caseResult) => caseResult.type === "qa" && !caseResult.shouldAbstain
  );
  const compareCases = caseResults.filter(
    (caseResult) => caseResult.type === "compare" && !caseResult.shouldAbstain
  );
  const abstainCases = caseResults.filter((caseResult) => caseResult.shouldAbstain);

  const summary = {
    runId,
    createdAt: new Date().toISOString(),
    corpus: {
      path: corpusPath,
      documents: documentRecords.length,
      cases: caseResults.length,
      qaCases: qaCases.length,
      compareCases: compareCases.length,
      abstainCases: abstainCases.length,
    },
    models: {
      embedding: getEmbeddingModel(),
      chat: getChatModel(),
    },
    config: {
      chunkStrategy: getChunkStrategy(),
      chunkSize: getChunkSize(),
      chunkOverlap: getChunkOverlap(),
      retrievalTopK: getRetrievalTopK(),
      compareTopKPerDoc: getComparisonTopKPerDoc(),
      maxComparisonSources: getMaxComparisonSources(),
      minRelevanceScore: getMinRelevanceScore(),
      nearDuplicateGuardEnabled: isNearDuplicateGuardEnabled(),
    },
    metrics: {
      overallPassRate: ratio(
        caseResults.filter((caseResult) => caseResult.passed).length,
        caseResults.length
      ),
      qaPageHitRate: ratio(
        qaCases.filter((caseResult) => caseResult.pageCoverageHit).length,
        qaCases.length
      ),
      compareDocCoverageRate: ratio(
        compareCases.filter((caseResult) => caseResult.docCoverageHit).length,
        compareCases.length
      ),
      comparePageHitRate: ratio(
        compareCases.filter((caseResult) => caseResult.pageCoverageHit).length,
        compareCases.length
      ),
      abstainAccuracy: ratio(
        abstainCases.filter((caseResult) => caseResult.abstained).length,
        abstainCases.length
      ),
      answerContentHitRate: ratio(
        caseResults.filter(
          (caseResult) => !caseResult.shouldAbstain && caseResult.answerExpectationHit
        ).length,
        caseResults.filter((caseResult) => !caseResult.shouldAbstain).length
      ),
      averageResponseTimeMs: average(
        caseResults.map((caseResult) => caseResult.responseTimeMs)
      ),
      averageCitationCount: average(
        caseResults.map((caseResult) => caseResult.citationCount)
      ),
    },
  };

  const resultPayload = {
    summary,
    documents: documentRecords,
    cases: caseResults,
  };
  const markdownReport = buildMarkdownReport({
    runId,
    corpusPath,
    summary,
    documentRecords,
    caseResults,
  });

  await writeJson(resultsRunJsonPath, resultPayload);
  await writeJson(latestJsonPath, resultPayload);
  await writeFile(resultsRunMarkdownPath, markdownReport, "utf8");
  await writeFile(latestMarkdownPath, markdownReport, "utf8");

  console.log(
    JSON.stringify(
      {
        runId,
        latestJsonPath,
        latestMarkdownPath,
        metrics: summary.metrics,
      },
      null,
      2
    )
  );
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
