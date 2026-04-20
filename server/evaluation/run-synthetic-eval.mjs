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
import {
  clearUploadSession,
  configureUploadSessionDirectory,
  finalizeUploadSession,
  getUploadSessionStatus,
  initializeUploadSession,
  storeUploadChunk,
} from "../upload-session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resultsDirectory = path.join(__dirname, "results");
const generatedDirectory = path.join(__dirname, "generated");
const defaultCorpusPath = path.join(__dirname, "synthetic-corpus.json");
const uploadChunkSizeBytes = 180;
const abstainPatterns = [
  "couldn't find enough grounded evidence",
  "comparison would be unreliable",
  "selected documents, so the comparison would be unreliable",
  "uploaded documents to answer reliably",
];

const toRunId = () => new Date().toISOString().replace(/[:.]/g, "-");

const escapePdfText = (text) =>
  text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const buildPageStream = (pageText) => {
  const lines = pageText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const commands = ["BT", "/F1 12 Tf", "72 720 Td"];

  lines.forEach((line, index) => {
    if (index > 0) {
      commands.push("0 -18 Td");
    }

    commands.push(`(${escapePdfText(line)}) Tj`);
  });

  commands.push("ET");

  return commands.join("\n");
};

const buildPdfBuffer = (pages) => {
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const contentObjectIds = pages.map((_, index) => 5 + index * 2);
  const objects = [
    {
      id: 1,
      body: "<< /Type /Catalog /Pages 2 0 R >>",
    },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pageObjectIds
        .map((id) => `${id} 0 R`)
        .join(" ")}] /Count ${pages.length} >>`,
    },
    {
      id: 3,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
  ];

  pages.forEach((pageText, index) => {
    const pageStream = buildPageStream(pageText);

    objects.push({
      id: pageObjectIds[index],
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjectIds[index]} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    });
    objects.push({
      id: contentObjectIds[index],
      body: `<< /Length ${Buffer.byteLength(pageStream, "utf8")} >>\nstream\n${pageStream}\nendstream`,
    });
  });

  const sortedObjects = objects.sort((left, right) => left.id - right.id);
  let pdf = "%PDF-1.4\n";
  const offsets = new Map();

  for (const entry of sortedObjects) {
    offsets.set(entry.id, Buffer.byteLength(pdf, "utf8"));
    pdf += `${entry.id} 0 obj\n${entry.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${sortedObjects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (const entry of sortedObjects) {
    pdf += `${String(offsets.get(entry.id)).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Root 1 0 R /Size ${sortedObjects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
};

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

const runUploadResumeFlow = async ({ buffer, fileName, runDirectory, uploadIndex }) => {
  const fileId = `synthetic-${uploadIndex}-${randomUUID()}`;
  const totalChunks = Math.max(1, Math.ceil(buffer.length / uploadChunkSizeBytes));
  const initiallyUploadedChunkCount = Math.max(1, Math.floor(totalChunks / 2));
  const mergedFilePath = path.join(runDirectory, fileName);

  await initializeUploadSession({
    fileId,
    fileName,
    fileSize: buffer.length,
    lastModified: 0,
    totalChunks,
    chunkSize: uploadChunkSizeBytes,
  });

  for (let chunkIndex = 0; chunkIndex < initiallyUploadedChunkCount; chunkIndex += 1) {
    const start = chunkIndex * uploadChunkSizeBytes;
    const end = Math.min(start + uploadChunkSizeBytes, buffer.length);

    await storeUploadChunk({
      fileId,
      chunkIndex,
      totalChunks,
      chunkBuffer: buffer.subarray(start, end),
    });
  }

  const pausedStatus = await getUploadSessionStatus(fileId);
  const resumedSession = await initializeUploadSession({
    fileId,
    fileName,
    fileSize: buffer.length,
    lastModified: 0,
    totalChunks,
    chunkSize: uploadChunkSizeBytes,
  });
  const alreadyUploadedChunks = new Set(resumedSession.uploadedChunks ?? []);
  let resumedBytesUploaded = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    if (alreadyUploadedChunks.has(chunkIndex)) {
      continue;
    }

    const start = chunkIndex * uploadChunkSizeBytes;
    const end = Math.min(start + uploadChunkSizeBytes, buffer.length);
    const chunkBuffer = buffer.subarray(start, end);

    resumedBytesUploaded += chunkBuffer.length;
    await storeUploadChunk({
      fileId,
      chunkIndex,
      totalChunks,
      chunkBuffer,
    });
  }

  await finalizeUploadSession({
    fileId,
    destinationPath: mergedFilePath,
  });

  const mergedBuffer = await readFile(mergedFilePath);
  await clearUploadSession(fileId);

  const skippedChunksOnResume = resumedSession.uploadedChunks.length;
  const skippedBytesOnResume = Math.max(0, buffer.length - resumedBytesUploaded);

  return {
    fileName,
    fileId,
    totalBytes: buffer.length,
    totalChunks,
    chunkSizeBytes: uploadChunkSizeBytes,
    pausedUploadedChunks: pausedStatus?.uploadedChunks ?? [],
    skippedChunksOnResume,
    skippedBytesOnResume,
    resumedBytesUploaded,
    mergedMatchesOriginal: Buffer.compare(buffer, mergedBuffer) === 0,
    mergedFilePath,
  };
};

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

const buildMarkdownReport = ({
  runId,
  corpusPath,
  summary,
  uploadResults,
  caseResults,
}) => {
  const lines = [
    "# Synthetic RAG Evaluation",
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
    "## Metrics",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Overall pass rate | ${summary.metrics.overallPassRate} |`,
    `| QA page hit rate | ${summary.metrics.qaPageHitRate} |`,
    `| Compare doc coverage | ${summary.metrics.compareDocCoverageRate} |`,
    `| Compare page hit rate | ${summary.metrics.comparePageHitRate} |`,
    `| Abstain accuracy | ${summary.metrics.abstainAccuracy} |`,
    `| Answer content hit rate | ${summary.metrics.answerContentHitRate} |`,
    `| Upload resume success rate | ${summary.metrics.uploadResumeSuccessRate} |`,
    `| Avg response time (ms) | ${summary.metrics.averageResponseTimeMs} |`,
    `| Avg citation count | ${summary.metrics.averageCitationCount} |`,
    `| Resume saved bytes | ${summary.metrics.totalSkippedBytesOnResume} |`,
    "",
    "## Upload Resume Checks",
    "",
    "| Document | Chunks | Skipped On Resume | Saved Bytes | Merge OK |",
    "| --- | ---: | ---: | ---: | --- |",
  ];

  for (const uploadResult of uploadResults) {
    lines.push(
      `| ${uploadResult.fileName} | ${uploadResult.totalChunks} | ${uploadResult.skippedChunksOnResume} | ${uploadResult.skippedBytesOnResume} | ${uploadResult.mergedMatchesOriginal ? "yes" : "no"} |`
    );
  }

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
    throw new Error(`Synthetic evaluation corpus not found at ${corpusPath}.`);
  }

  const runId = toRunId();
  const runDirectory = path.join(generatedDirectory, runId);
  const mergedDirectory = path.join(runDirectory, "merged");
  const sourceDirectory = path.join(runDirectory, "source");
  const resultsRunJsonPath = path.join(resultsDirectory, `${runId}.json`);
  const resultsRunMarkdownPath = path.join(resultsDirectory, `${runId}.md`);
  const latestJsonPath = path.join(resultsDirectory, "latest.json");
  const latestMarkdownPath = path.join(resultsDirectory, "latest.md");
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const ragDataDirectory = path.join(runDirectory, "rag-data");
  const uploadSessionDirectory = path.join(runDirectory, "upload-sessions");

  await mkdir(resultsDirectory, { recursive: true });
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(mergedDirectory, { recursive: true });

  configureRagDataDirectory(ragDataDirectory);
  resetDocumentRegistry();
  resetVectorStore();
  resetSessionMemory();
  configureUploadSessionDirectory(uploadSessionDirectory);

  const uploadResults = [];
  const docIdByKey = new Map();
  const docKeyByDocId = new Map();
  const documentRecords = [];

  for (const [index, documentSpec] of corpus.documents.entries()) {
    const buffer = buildPdfBuffer(documentSpec.pages);
    const sourcePath = path.join(sourceDirectory, documentSpec.fileName);

    await writeFile(sourcePath, buffer);

    const uploadResult = await runUploadResumeFlow({
      buffer,
      fileName: documentSpec.fileName,
      runDirectory: mergedDirectory,
      uploadIndex: index,
    });
    uploadResults.push({
      ...uploadResult,
      sourcePath,
    });

    const docId = randomUUID();
    const documentRecord = await ingestDocument({
      docId,
      filePath: uploadResult.mergedFilePath,
      fileName: documentSpec.fileName,
    });

    docIdByKey.set(documentSpec.key, docId);
    docKeyByDocId.set(docId, documentSpec.key);
    documentRecords.push({
      docKey: documentSpec.key,
      docId,
      fileName: documentSpec.fileName,
      sourcePath,
      mergedFilePath: uploadResult.mergedFilePath,
      pageCount: documentRecord.pageCount,
      chunkCount: documentRecord.chunkCount,
    });
  }

  const caseResults = [];

  for (const testCase of corpus.cases) {
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
  const successfulUploads = uploadResults.filter(
    (uploadResult) =>
      uploadResult.mergedMatchesOriginal && uploadResult.skippedChunksOnResume > 0
  );

  const summary = {
    runId,
    createdAt: new Date().toISOString(),
    corpus: {
      path: corpusPath,
      documents: corpus.documents.length,
      cases: corpus.cases.length,
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
      uploadChunkSizeBytes,
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
      uploadResumeSuccessRate: ratio(
        successfulUploads.length,
        uploadResults.length
      ),
      averageResponseTimeMs: average(
        caseResults.map((caseResult) => caseResult.responseTimeMs)
      ),
      averageCitationCount: average(
        caseResults.map((caseResult) => caseResult.citationCount)
      ),
      totalSkippedBytesOnResume: uploadResults.reduce(
        (sum, uploadResult) => sum + uploadResult.skippedBytesOnResume,
        0
      ),
    },
  };

  const resultPayload = {
    summary,
    documents: documentRecords,
    uploads: uploadResults,
    cases: caseResults,
  };
  const markdownReport = buildMarkdownReport({
    runId,
    summary,
    corpusPath,
    uploadResults,
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
