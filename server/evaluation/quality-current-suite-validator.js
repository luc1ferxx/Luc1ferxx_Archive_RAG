import {
  CURRENT_QUALITY_SUITE_MANIFEST,
  CURRENT_QUALITY_SUITE_MANIFEST_VERSION,
} from "./quality-current-suite-manifest.js";
import {
  validateCheckSuiteRawIntegrity,
} from "./quality-check-suite-integrity.js";
import {
  EVAL_EVIDENCE_GENERATOR_VERSION,
  EVAL_EVIDENCE_SCHEMA_VERSION,
} from "./eval-evidence.js";
import { evaluateAnswerExpectation } from "./answer-match.js";
import { evaluateExpectedCoverage } from "./eval-case-helpers.js";
import { splitAnswerClaims } from "../rag/self-check/claims.js";
import { evaluateClaimSupport } from "../rag/self-check/evaluate.js";

const toArray = (value) => (Array.isArray(value) ? value : []);

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

const toIds = (items) =>
  toArray(items).map((item) =>
    typeof item?.id === "string" ? item.id.trim() : ""
  );

const findDuplicateIds = (ids) => {
  const seen = new Set();
  const duplicates = new Set();

  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }

    seen.add(id);
  }

  return [...duplicates].sort();
};

const difference = (left, right) => {
  const rightSet = new Set(right);

  return [...new Set(left)].filter((item) => !rightSet.has(item)).sort();
};

const normalizeText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeStringArray = (value) =>
  toArray(value).map((item) => normalizeText(item));

const normalizeExpectedEvidence = (value) =>
  toArray(value).map((entry) => ({
    docKey: normalizeText(entry?.docKey),
    pages: toArray(entry?.pages).map((page) => Number(page)),
  }));

const normalizeCaseSemantics = (value = {}) => ({
  docKeys: normalizeStringArray(value.docKeys),
  expectedAnswerIncludes: normalizeStringArray(
    value.expectedAnswerIncludes
  ),
  expectedEvidence: normalizeExpectedEvidence(value.expectedEvidence),
  question: normalizeText(value.question),
  shouldAbstain: value.shouldAbstain,
  type: normalizeText(value.type),
});

const normalizeClaimContract = (claims) =>
  toArray(claims).map((claim) => ({
    sourceRanks: toArray(claim?.sourceRanks).map((rank) => Number(rank)),
    text: normalizeText(claim?.text),
  }));

const deriveAnswerClaimContract = ({ answer, citations }) =>
  splitAnswerClaims(answer, citations).map((claim) => ({
    sourceRanks: claim.sourceRanks,
    text: normalizeText(claim.text),
  }));

const isExplicitAbstainAnswer = (answer) => {
  const text = normalizeText(answer);

  if (!text) {
    return false;
  }

  return [
    /^I (?:could not|couldn't) find enough grounded evidence in (?:the )?(?:uploaded|selected) documents(?: to answer reliably| to compare them)?[.!]?$/i,
    /^I (?:could not|couldn't) find enough grounded evidence that specifically addresses [^.!?]+(?: in \d+ of the \d+ selected documents, so the comparison would be unreliable)?[.!]?$/i,
    /^I do not have enough citation-backed evidence to answer reliably[.!]?$/i,
    /^I have not found reliable evidence that directly answers [^.!?]+[.!]?$/i,
    /^I only found strong evidence in \d+ of the \d+ selected documents, so the comparison would be unreliable[.!]?$/i,
  ].some((pattern) => pattern.test(text));
};

const toUniqueNonEmptyStrings = (items) =>
  toArray(items)
    .map((item) => normalizeText(item))
    .filter(Boolean);

const addMetricMismatch = ({
  actual,
  errors,
  expected,
  metric,
}) => {
  if (actual !== expected) {
    errors.push({
      actual: actual ?? null,
      expected: expected ?? null,
      id: `summary.${metric}`,
    });
  }
};

const validateReportEnvelopeIntegrity = (report) => {
  if (!report) {
    return [];
  }

  const errors = [];
  const pairs = [
    {
      actual: report?.evidence?.runId,
      expected: report?.summary?.runId,
      id: "envelope.runId",
    },
    {
      actual: report?.evidence?.generatedAt,
      expected: report?.summary?.createdAt,
      id: "envelope.generatedAt",
    },
    {
      actual: report?.evidence?.schemaVersion,
      expected: EVAL_EVIDENCE_SCHEMA_VERSION,
      id: "envelope.schemaVersion",
    },
    {
      actual: report?.evidence?.generatorVersion,
      expected: EVAL_EVIDENCE_GENERATOR_VERSION,
      id: "envelope.generatorVersion",
    },
  ];

  for (const pair of pairs) {
    if (
      !normalizeText(pair.actual) ||
      !normalizeText(pair.expected) ||
      pair.actual !== pair.expected
    ) {
      errors.push(pair);
    }
  }

  return errors;
};

const buildRawCaseMetrics = (cases) => {
  const checks = cases.flatMap((caseResult) => toArray(caseResult.checks));
  const passedCaseCount = cases.filter(
    (caseResult) => caseResult?.passed === true
  ).length;
  const passedCheckCount = checks.filter((check) => check?.passed === true)
    .length;

  return {
    caseCount: cases.length,
    checkCount: checks.length,
    checkPassRate: ratio(passedCheckCount, checks.length),
    failedCaseCount: cases.length - passedCaseCount,
    failedCheckCount: checks.length - passedCheckCount,
    overallPassRate: ratio(passedCaseCount, cases.length),
    passedCaseCount,
    passedCheckCount,
  };
};

const validateCheckSuiteIntegrity = ({
  cases,
  manifest,
  report,
  specId,
}) => {
  const errors = [];

  for (const caseResult of cases) {
    const checks = toArray(caseResult?.checks);
    const derivedPassed = checks.every((check) => check?.passed === true);
    const failedCheckCount = checks.filter(
      (check) => check?.passed !== true
    ).length;

    if (typeof caseResult?.passed !== "boolean") {
      errors.push({
        actual: typeof caseResult?.passed,
        expected: "boolean",
        id: `case.${caseResult?.id ?? "unknown"}.passed_type`,
      });
    } else if (caseResult.passed !== derivedPassed) {
      errors.push({
        actual: caseResult.passed,
        expected: derivedPassed,
        id: `case.${caseResult.id}.passed`,
      });
    }

    if (caseResult?.failedCheckCount !== failedCheckCount) {
      errors.push({
        actual: caseResult?.failedCheckCount ?? null,
        expected: failedCheckCount,
        id: `case.${caseResult?.id ?? "unknown"}.failedCheckCount`,
      });
    }

    for (const check of checks) {
      if (typeof check?.passed !== "boolean") {
        errors.push({
          actual: typeof check?.passed,
          expected: "boolean",
          id: `check.${caseResult?.id ?? "unknown"}.${
            check?.id ?? "unknown"
          }.passed_type`,
        });
      }
    }
  }

  const rawMetrics = buildRawCaseMetrics(cases);
  const summary = report?.summary ?? {};
  const metrics = summary.metrics ?? {};

  for (const metric of [
    "caseCount",
    "checkCount",
    "failedCaseCount",
    "failedCheckCount",
    "passedCaseCount",
    "passedCheckCount",
    "overallPassRate",
    "checkPassRate",
  ]) {
    addMetricMismatch({
      actual: metrics[metric],
      errors,
      expected: rawMetrics[metric],
      metric: `metrics.${metric}`,
    });
  }

  addMetricMismatch({
    actual: summary.status,
    errors,
    expected:
      rawMetrics.failedCaseCount > 0 || rawMetrics.failedCheckCount > 0
        ? "fail"
        : "pass",
    metric: "status",
  });

  errors.push(
    ...validateCheckSuiteRawIntegrity({
      cases,
      manifest,
      report,
      specId,
    })
  );

  return {
    errors,
    rawMetrics,
  };
};

const validateSyntheticRawIdentities = ({
  corpusContract,
  manifest,
  report,
}) => {
  const errors = [];
  const corpusDocuments = toArray(corpusContract?.documents);
  const documents = toArray(report?.documents);
  const uploads = toArray(report?.uploads);
  const requiredConfig = manifest?.requiredConfig ?? {};
  const actualConfig = report?.summary?.config ?? {};

  if (JSON.stringify(actualConfig) !== JSON.stringify(requiredConfig)) {
    errors.push({
      actual: actualConfig,
      expected: requiredConfig,
      id: "summary.config_contract",
    });
  }
  const corpusDocumentsByKey = new Map(
    corpusDocuments.map((document) => [
      normalizeText(document?.key),
      {
        chunkCount:
          manifest?.requiredDocuments?.[
            normalizeText(document?.key)
          ]?.chunkCount,
        fileName: normalizeText(document?.fileName),
        pageCount: document?.pageCount,
        pages: toArray(document?.pages).map((page) =>
          normalizeText(page)
        ),
        totalBytes:
          manifest?.requiredDocuments?.[
            normalizeText(document?.key)
          ]?.totalBytes,
      },
    ])
  );
  const documentsByKey = new Map(
    documents.map((document) => [
      normalizeText(document?.docKey),
      document,
    ])
  );
  const documentsByFileName = new Map(
    documents.map((document) => [
      normalizeText(document?.fileName),
      document,
    ])
  );
  const identityFields = [
    {
      expected: "unique non-empty document keys",
      id: "raw.documents.docKey",
      values: documents.map((document) => document?.docKey),
    },
    {
      expected: "unique non-empty document IDs",
      id: "raw.documents.docId",
      values: documents.map((document) => document?.docId),
    },
    {
      expected: "unique non-empty document file names",
      id: "raw.documents.fileName",
      values: documents.map((document) => document?.fileName),
    },
    {
      expected: "unique non-empty upload file names",
      id: "raw.uploads.fileName",
      values: uploads.map((upload) => upload?.fileName),
    },
    {
      expected: "unique non-empty upload file IDs",
      id: "raw.uploads.fileId",
      values: uploads.map((upload) => upload?.fileId),
    },
  ];

  if (!Array.isArray(report?.documents) || !Array.isArray(report?.uploads)) {
    errors.push({
      actual: {
        documents: typeof report?.documents,
        uploads: typeof report?.uploads,
      },
      expected: "document and upload arrays",
      id: "raw.document_upload_shape",
    });
  }

  for (const field of identityFields) {
    const values = toUniqueNonEmptyStrings(field.values);
    const duplicates = findDuplicateIds(values);

    if (values.length !== field.values.length || duplicates.length > 0) {
      errors.push({
        actual: {
          duplicates,
          values,
        },
        expected: field.expected,
        id: field.id,
      });
    }
  }

  const expectedDocumentKeys = [...corpusDocumentsByKey.keys()];
  const actualDocumentKeys = documents.map((document) =>
    normalizeText(document?.docKey)
  );
  const expectedFileNames = corpusDocuments.map((document) =>
    normalizeText(document?.fileName)
  );
  const actualUploadFileNames = uploads.map((upload) =>
    normalizeText(upload?.fileName)
  );

  for (const [id, actual, expected] of [
    ["raw.documents.coverage", actualDocumentKeys, expectedDocumentKeys],
    ["raw.uploads.coverage", actualUploadFileNames, expectedFileNames],
  ]) {
    const missing = difference(expected, actual);
    const extra = difference(actual, expected);

    if (missing.length > 0 || extra.length > 0) {
      errors.push({
        actual: {
          extra,
          missing,
        },
        expected,
        id,
      });
    }
  }

  for (const document of documents) {
    const docKey = normalizeText(document?.docKey);
    const corpusDocument = corpusDocumentsByKey.get(docKey);
    const expectedSourcePath = `server/evaluation/generated/${normalizeText(
      report?.summary?.runId
    )}/source/${corpusDocument?.fileName ?? ""}`;
    const expectedMergedPath = `server/evaluation/generated/${normalizeText(
      report?.summary?.runId
    )}/merged/${corpusDocument?.fileName ?? ""}`;

    if (
      !corpusDocument ||
      normalizeText(document?.fileName) !== corpusDocument.fileName ||
      document?.pageCount !== corpusDocument.pageCount ||
      !Number.isInteger(document?.pageCount) ||
      document.pageCount <= 0 ||
      !Number.isSafeInteger(document?.chunkCount) ||
      document.chunkCount !== corpusDocument.chunkCount ||
      normalizeText(document?.sourcePath) !== expectedSourcePath ||
      normalizeText(document?.mergedFilePath) !== expectedMergedPath
    ) {
      errors.push({
        actual: {
          chunkCount: document?.chunkCount ?? null,
          docKey,
          fileName: document?.fileName ?? null,
          mergedFilePath: document?.mergedFilePath ?? null,
          pageCount: document?.pageCount ?? null,
          sourcePath: document?.sourcePath ?? null,
        },
        expected: corpusDocument ?? "known corpus document",
        id: `raw.document.${docKey || "unknown"}.identity`,
      });
    }
  }

  for (const upload of uploads) {
    const fileName = normalizeText(upload?.fileName);
    const document = documentsByFileName.get(fileName);
    const corpusDocument = corpusDocumentsByKey.get(
      normalizeText(document?.docKey)
    );
    const totalBytes = upload?.totalBytes;
    const totalChunks = upload?.totalChunks;
    const chunkSizeBytes = upload?.chunkSizeBytes;
    const pausedUploadedChunks = upload?.pausedUploadedChunks;
    const skippedChunksOnResume = upload?.skippedChunksOnResume;
    const skippedBytesOnResume = upload?.skippedBytesOnResume;
    const resumedBytesUploaded = upload?.resumedBytesUploaded;
    const validPausedChunks =
      Array.isArray(pausedUploadedChunks) &&
      pausedUploadedChunks.every(
        (chunkIndex) =>
          Number.isInteger(chunkIndex) &&
          chunkIndex >= 0 &&
          Number.isInteger(totalChunks) &&
          chunkIndex < totalChunks
      ) &&
      findDuplicateIds(pausedUploadedChunks).length === 0;
    const expectedTotalChunks =
      Number.isSafeInteger(corpusDocument?.totalBytes) &&
      Number.isSafeInteger(requiredConfig.uploadChunkSizeBytes)
        ? Math.ceil(
            corpusDocument.totalBytes /
              requiredConfig.uploadChunkSizeBytes
          )
        : null;
    const expectedPausedChunkCount = Number.isSafeInteger(
      expectedTotalChunks
    )
      ? Math.max(1, Math.floor(expectedTotalChunks / 2))
      : null;
    const validExpectedPausedChunks =
      Array.isArray(pausedUploadedChunks) &&
      Number.isSafeInteger(expectedPausedChunkCount) &&
      pausedUploadedChunks.length === expectedPausedChunkCount &&
      pausedUploadedChunks.every(
        (chunkIndex, index) => chunkIndex === index
      );
    const derivedSkippedBytes = validPausedChunks
      ? pausedUploadedChunks.reduce(
          (sum, chunkIndex) =>
            sum +
            Math.min(
              chunkSizeBytes,
              totalBytes - chunkIndex * chunkSizeBytes
            ),
          0
        )
      : null;
    const valid =
      Number.isSafeInteger(totalBytes) &&
      totalBytes === corpusDocument?.totalBytes &&
      Number.isSafeInteger(chunkSizeBytes) &&
      chunkSizeBytes > 0 &&
      chunkSizeBytes === requiredConfig.uploadChunkSizeBytes &&
      Number.isSafeInteger(totalChunks) &&
      totalChunks === expectedTotalChunks &&
      validPausedChunks &&
      Number.isSafeInteger(skippedChunksOnResume) &&
      skippedChunksOnResume > 0 &&
      skippedChunksOnResume < totalChunks &&
      skippedChunksOnResume === pausedUploadedChunks.length &&
      Number.isSafeInteger(skippedBytesOnResume) &&
      skippedBytesOnResume > 0 &&
      skippedBytesOnResume === derivedSkippedBytes &&
      Number.isSafeInteger(resumedBytesUploaded) &&
      resumedBytesUploaded > 0 &&
      skippedBytesOnResume + resumedBytesUploaded === totalBytes &&
      upload?.mergedMatchesOriginal === true &&
      validExpectedPausedChunks &&
      normalizeText(upload?.sourcePath) ===
        normalizeText(document?.sourcePath) &&
      normalizeText(upload?.mergedFilePath) ===
        normalizeText(document?.mergedFilePath);

    if (!valid) {
      errors.push({
        actual: {
          chunkSizeBytes: chunkSizeBytes ?? null,
          mergedMatchesOriginal:
            upload?.mergedMatchesOriginal ?? null,
          mergedFilePath: upload?.mergedFilePath ?? null,
          pausedUploadedChunks: pausedUploadedChunks ?? null,
          resumedBytesUploaded: resumedBytesUploaded ?? null,
          skippedBytesOnResume: skippedBytesOnResume ?? null,
          skippedChunksOnResume: skippedChunksOnResume ?? null,
          totalBytes: totalBytes ?? null,
          totalChunks: totalChunks ?? null,
          sourcePath: upload?.sourcePath ?? null,
        },
        expected: {
          fileName: corpusDocument?.fileName ?? null,
          mergedFilePath: document?.mergedFilePath ?? null,
          pausedUploadedChunkCount: expectedPausedChunkCount,
          sourcePath: document?.sourcePath ?? null,
          totalBytes: corpusDocument?.totalBytes ?? null,
        },
        id: `raw.upload.${fileName || "unknown"}`,
      });
    }
  }

  return {
    corpusDocumentsByKey,
    documentsByKey,
    errors,
  };
};

const validateSyntheticIntegrity = ({
  cases,
  corpusContract,
  manifest,
  report,
}) => {
  const rawIdentityValidation = validateSyntheticRawIdentities({
    corpusContract,
    manifest,
    report,
  });
  const errors = [...rawIdentityValidation.errors];
  const expectedCasesById = new Map(
    toArray(corpusContract?.cases).map((caseDefinition) => [
      caseDefinition.id,
      caseDefinition,
    ])
  );
  const derivedCases = [];

  for (const caseResult of cases) {
    const expectedCase = expectedCasesById.get(caseResult?.id) ?? {};
    const citations = toArray(caseResult?.citations);
    const retrievedContexts = toArray(caseResult?.retrievedContexts);
    const citationRanks = citations.map((citation) => Number(citation?.rank));
    const duplicateCitationRanks = findDuplicateIds(citationRanks);
    const expectedCitationRanks = citations.map((_, index) => index + 1);
    const duplicateCitationIdentities = findDuplicateIds(
      citations.map(
        (citation) =>
          `${normalizeText(citation?.docId)}:${Number(
            citation?.pageNumber
          )}`
      )
    );
    const selectedDocKeys = new Set(toArray(caseResult?.docKeys));
    const toEvidenceIdentity = (entry) => ({
      docId: normalizeText(entry?.docId),
      docKey: normalizeText(entry?.docKey),
      fileName: normalizeText(entry?.fileName),
      pageNumber: Number(entry?.pageNumber),
      rank: Number(entry?.rank),
      score: entry?.score,
    });
    const invalidCitations = citations.filter((citation) => {
      const document = rawIdentityValidation.documentsByKey.get(
        normalizeText(citation?.docKey)
      );
      const score = citation?.score;
      const minimumScore = manifest?.requiredConfig?.minRelevanceScore;

      return Boolean(
        !document ||
          normalizeText(citation?.docId) !==
            normalizeText(document?.docId) ||
          normalizeText(citation?.fileName) !==
            normalizeText(document?.fileName) ||
          !selectedDocKeys.has(citation?.docKey) ||
          !Number.isInteger(citation?.rank) ||
          citation.rank <= 0 ||
          !Number.isInteger(citation?.pageNumber) ||
          citation.pageNumber <= 0 ||
          citation.pageNumber > document.pageCount ||
          !Number.isFinite(score) ||
          !Number.isFinite(minimumScore) ||
          score < minimumScore
      );
    });
    const retrievedContextRanks = retrievedContexts.map((context) =>
      Number(context?.rank)
    );
    const duplicateRetrievedContextIdentities = findDuplicateIds(
      retrievedContexts.map(
        (context) =>
          `${normalizeText(context?.docId)}:${Number(
            context?.pageNumber
          )}`
      )
    );
    const invalidRetrievedContexts = retrievedContexts.filter(
      (context) => {
        const document = rawIdentityValidation.documentsByKey.get(
          normalizeText(context?.docKey)
        );
        const corpusDocument =
          rawIdentityValidation.corpusDocumentsByKey.get(
            normalizeText(context?.docKey)
          );
        const pageNumber = Number(context?.pageNumber);
        const score = context?.score;
        const minimumScore =
          manifest?.requiredConfig?.minRelevanceScore;
        const expectedPageText =
          Number.isInteger(pageNumber) && pageNumber > 0
            ? corpusDocument?.pages?.[pageNumber - 1] ?? ""
            : "";

        return Boolean(
          !document ||
            normalizeText(context?.docId) !==
              normalizeText(document?.docId) ||
            normalizeText(context?.fileName) !==
              normalizeText(document?.fileName) ||
            !selectedDocKeys.has(context?.docKey) ||
            !Number.isInteger(context?.rank) ||
            context.rank <= 0 ||
            !Number.isInteger(pageNumber) ||
            pageNumber <= 0 ||
            pageNumber > document.pageCount ||
            !Number.isSafeInteger(context?.chunkIndex) ||
            context.chunkIndex !== pageNumber - 1 ||
            !Number.isFinite(score) ||
            !Number.isFinite(minimumScore) ||
            score < minimumScore ||
            normalizeText(context?.text) !==
              normalizeText(expectedPageText)
        );
      }
    );
    const retrievedEvidenceIdentities = retrievedContexts.map(
      toEvidenceIdentity
    );
    const unmatchedCitationIdentities = citations
      .map(toEvidenceIdentity)
      .filter(
        (citationIdentity) =>
          retrievedEvidenceIdentities.filter(
            (contextIdentity) =>
              JSON.stringify(contextIdentity) ===
              JSON.stringify(citationIdentity)
          ).length !== 1
      );
    const ragasSample = caseResult?.ragasSample;
    const expectedRagasContextIds = retrievedContexts.map(
      (context) =>
        `${normalizeText(context?.docKey)}:${Number(
          context?.pageNumber
        )}`
    );
    const expectedRagasContexts = retrievedContexts.map((context) =>
      String(context?.text ?? "")
    );
    const ragasContractValid =
      ragasSample &&
      ragasSample.caseId === caseResult?.id &&
      normalizeText(ragasSample.user_input) ===
        normalizeText(caseResult?.question) &&
      normalizeText(ragasSample.response) ===
        normalizeText(caseResult?.answer) &&
      JSON.stringify(ragasSample.retrieved_context_ids) ===
        JSON.stringify(expectedRagasContextIds) &&
      JSON.stringify(ragasSample.retrieved_contexts) ===
        JSON.stringify(expectedRagasContexts);

    if (
      !Array.isArray(caseResult?.citations) ||
      citationRanks.some(
        (rank) => !Number.isInteger(rank) || rank <= 0
      ) ||
      JSON.stringify(citationRanks) !==
        JSON.stringify(expectedCitationRanks) ||
      duplicateCitationRanks.length > 0 ||
      duplicateCitationIdentities.length > 0 ||
      invalidCitations.length > 0
    ) {
      errors.push({
        actual: {
          citationRanks,
          duplicateCitationIdentities,
          duplicateCitationRanks,
          invalidCitations,
        },
        expected:
          "contiguous unique citations matching selected raw documents",
        id: `case.${caseResult?.id ?? "unknown"}.citation_identity`,
      });
    }

    if (
      !Array.isArray(caseResult?.retrievedContexts) ||
      retrievedContextRanks.some(
        (rank, index) =>
          !Number.isInteger(rank) || rank !== index + 1
      ) ||
      duplicateRetrievedContextIdentities.length > 0 ||
      invalidRetrievedContexts.length > 0 ||
      unmatchedCitationIdentities.length > 0 ||
      !ragasContractValid
    ) {
      errors.push({
        actual: {
          duplicateRetrievedContextIdentities,
          invalidRetrievedContexts,
          ragasContractValid,
          retrievedContextRanks,
          unmatchedCitationIdentities,
        },
        expected:
          "citations backed by contiguous raw retrieval and derived Ragas context identity",
        id: `case.${caseResult?.id ?? "unknown"}.retrieval_contract`,
      });
    }

    const coverage = evaluateExpectedCoverage({
      citations,
      expectedEvidence: expectedCase.expectedEvidence,
    });
    const answerExpectationHit = evaluateAnswerExpectation({
      answer: caseResult?.answer,
      expectedAnswerIncludes: expectedCase.expectedAnswerIncludes,
    });
    const expectedAbstainAnswer =
      manifest?.expectedAbstainAnswers?.[caseResult?.id] ?? null;
    const derivedAbstained = expectedAbstainAnswer
      ? normalizeText(caseResult?.answer) ===
        normalizeText(expectedAbstainAnswer)
      : isExplicitAbstainAnswer(caseResult?.answer);
    const trustedCitations = citations.map((citation) => {
      const corpusDocument =
        rawIdentityValidation.corpusDocumentsByKey.get(
          normalizeText(citation?.docKey)
        );
      const pageNumber = Number(citation?.pageNumber);
      const evidenceText =
        Number.isInteger(pageNumber) && pageNumber > 0
          ? corpusDocument?.pages?.[pageNumber - 1] ?? ""
          : "";

      return {
        ...citation,
        evidenceText,
      };
    });
    const expectsNoMaterialDifference = normalizeStringArray(
      expectedCase.expectedAnswerIncludes
    ).some((fragment) =>
      fragment
        .toLowerCase()
        .includes("no evidence-backed material differences were found")
    );
    const independentlyEvaluatedClaimSupport =
      expectedCase.shouldAbstain === true
        ? null
        : evaluateClaimSupport({
            answerText: caseResult?.answer,
            citations: trustedCitations,
            comparisonAnalysisSummary: expectsNoMaterialDifference
              ? {
                  comparedDocIds: trustedCitations.map(
                    (citation) => citation.docId
                  ),
                  explicitConflictPairs: [],
                  shouldShortCircuitNoMaterialDifference: true,
                }
              : null,
          });

    if (caseResult?.abstained !== derivedAbstained) {
      errors.push({
        actual: caseResult?.abstained ?? null,
        expected: derivedAbstained,
        id: `case.${caseResult?.id ?? "unknown"}.abstained`,
      });
    }

    if (
      expectedCase.shouldAbstain === true &&
      (normalizeText(caseResult?.abstainReason) !==
        normalizeText(caseResult?.answer) ||
        !derivedAbstained)
    ) {
      errors.push({
        actual: {
          abstainReason: caseResult?.abstainReason ?? null,
          answer: caseResult?.answer ?? null,
        },
        expected: "matching explicit abstention answer and reason",
        id: `case.${caseResult?.id ?? "unknown"}.abstain_reason`,
      });
    }

    for (const field of [
      "passed",
      "shouldAbstain",
      "abstained",
      "docCoverageHit",
      "pageCoverageHit",
      "answerExpectationHit",
      "claimSupportHit",
    ]) {
      if (typeof caseResult?.[field] !== "boolean") {
        errors.push({
          actual: typeof caseResult?.[field],
          expected: "boolean",
          id: `case.${caseResult?.id ?? "unknown"}.${field}_type`,
        });
      }
    }

    const claimSupport = caseResult?.claimSupport;
    const claims = claimSupport?.claims;
    const unsupportedClaimCount = claimSupport?.unsupportedClaimCount;
    const supportedClaimCount = claimSupport?.supportedClaimCount;

    let derivedClaimSupportHit = false;

    if (
      !claimSupport ||
      typeof claimSupport.checked !== "boolean" ||
      !Array.isArray(claims) ||
      !Number.isInteger(unsupportedClaimCount) ||
      unsupportedClaimCount < 0 ||
      !Number.isInteger(supportedClaimCount) ||
      supportedClaimCount < 0
    ) {
      errors.push({
        actual: claimSupport ?? null,
        expected: "claim-support summary",
        id: `case.${caseResult?.id ?? "unknown"}.claimSupport`,
      });
    } else {
      const invalidSupportedClaims = claims.filter(
        (claim) => typeof claim?.supported !== "boolean"
      );
      const reportedUnsupportedClaimCount = claims.filter(
        (claim) => claim?.supported === false
      ).length;
      const reportedSupportedClaimCount = claims.filter(
        (claim) => claim?.supported === true
      ).length;
      const independentClaims =
        independentlyEvaluatedClaimSupport?.claims ?? [];
      const independentUnsupportedClaimCount =
        independentlyEvaluatedClaimSupport?.unsupportedClaimCount ?? 0;
      const independentSupportedClaimCount =
        independentlyEvaluatedClaimSupport?.supportedClaimCount ?? 0;
      const answerClaimContract = deriveAnswerClaimContract({
        answer: caseResult?.answer,
        citations,
      });
      const requiredAnswerClaimContract = normalizeClaimContract(
        manifest?.requiredAnswerClaims?.[caseResult?.id]
      );
      const reportedClaimContract = normalizeClaimContract(claims);
      const claimContractMatches =
        JSON.stringify(answerClaimContract) ===
        JSON.stringify(reportedClaimContract);
      const requiredAnswerClaimContractMatches =
        requiredAnswerClaimContract.length === 0 ||
        JSON.stringify(answerClaimContract) ===
          JSON.stringify(requiredAnswerClaimContract);
      const usedSourceRanks = [
        ...new Set(
          answerClaimContract.flatMap((claim) => claim.sourceRanks)
        ),
      ].sort((left, right) => left - right);
      const allCitationsUsed =
        expectedCase.shouldAbstain === true ||
        JSON.stringify(usedSourceRanks) ===
          JSON.stringify(expectedCitationRanks);
      const independentSupportVerdicts =
        independentClaims.map((claim) => Boolean(claim?.supported));
      const reportedSupportVerdicts = claims.map((claim) =>
        Boolean(claim?.supported)
      );
      const supportVerdictsMatch =
        JSON.stringify(independentSupportVerdicts) ===
        JSON.stringify(reportedSupportVerdicts);
      const abstainClaimContractValid =
        claimSupport.checked === false &&
        claims.length === 0 &&
        supportedClaimCount === 0 &&
        unsupportedClaimCount === 0;
      const answerClaimContractValid =
        claimSupport.checked === true &&
        claims.length > 0 &&
        answerClaimContract.length > 0 &&
        claimContractMatches &&
        requiredAnswerClaimContractMatches &&
        allCitationsUsed &&
        independentlyEvaluatedClaimSupport?.checked === true &&
        independentClaims.length === claims.length &&
        supportVerdictsMatch;
      derivedClaimSupportHit =
        expectedCase.shouldAbstain === true
          ? abstainClaimContractValid
          : answerClaimContractValid &&
            invalidSupportedClaims.length === 0 &&
            independentUnsupportedClaimCount === 0;

      if (
        invalidSupportedClaims.length > 0 ||
        (!claimSupport.checked && claims.length > 0) ||
        unsupportedClaimCount !==
          (expectedCase.shouldAbstain === true
            ? reportedUnsupportedClaimCount
            : independentUnsupportedClaimCount) ||
        supportedClaimCount !==
          (expectedCase.shouldAbstain === true
            ? reportedSupportedClaimCount
            : independentSupportedClaimCount) ||
        (expectedCase.shouldAbstain !== true &&
          !supportVerdictsMatch)
      ) {
        errors.push({
          actual: {
            checked: claimSupport.checked,
            claimCount: claims.length,
            invalidSupportedClaimCount: invalidSupportedClaims.length,
            supportedClaimCount,
            unsupportedClaimCount,
          },
          expected: {
            checked: claims.length > 0 ? true : claimSupport.checked,
            supportedClaimCount:
              expectedCase.shouldAbstain === true
                ? reportedSupportedClaimCount
                : independentSupportedClaimCount,
            unsupportedClaimCount:
              expectedCase.shouldAbstain === true
                ? reportedUnsupportedClaimCount
                : independentUnsupportedClaimCount,
          },
          id: `case.${caseResult.id}.claimSupport_counts`,
        });
      }

      if (
        expectedCase.shouldAbstain !== true &&
        (!requiredAnswerClaimContractMatches || !allCitationsUsed)
      ) {
        errors.push({
          actual: {
            answerClaims: answerClaimContract,
            usedSourceRanks,
          },
          expected: {
            answerClaims: requiredAnswerClaimContract,
            usedSourceRanks: expectedCitationRanks,
          },
          id: `case.${caseResult.id}.answer_claim_contract`,
        });
      }

      if (
        (expectedCase.shouldAbstain === true &&
          !abstainClaimContractValid) ||
        (expectedCase.shouldAbstain !== true &&
          !answerClaimContractValid)
      ) {
        errors.push({
          actual: {
            answerClaims: answerClaimContract,
            checked: claimSupport.checked,
            reportedClaims: reportedClaimContract,
          },
          expected:
            expectedCase.shouldAbstain === true
              ? "unchecked empty claims for an explicit abstention"
              : "checked claims exactly covering the answer",
          id: `case.${caseResult.id}.claim_contract`,
        });
      }

      if (caseResult.claimSupportHit !== derivedClaimSupportHit) {
        errors.push({
          actual: caseResult.claimSupportHit,
          expected: derivedClaimSupportHit,
          id: `case.${caseResult.id}.claimSupportHit`,
        });
      }
    }

    const derivedPassed =
      expectedCase.shouldAbstain === true
        ? derivedAbstained &&
          coverage.docCoverageHit &&
          coverage.pageCoverageHit
        : !derivedAbstained &&
          coverage.docCoverageHit &&
          coverage.pageCoverageHit &&
          answerExpectationHit &&
          derivedClaimSupportHit;

    for (const [field, expected] of Object.entries({
      answerExpectationHit,
      abstained: derivedAbstained,
      claimSupportHit: derivedClaimSupportHit,
      docCoverageHit: coverage.docCoverageHit,
      pageCoverageHit: coverage.pageCoverageHit,
      passed: derivedPassed,
    })) {
      if (caseResult?.[field] !== expected) {
        errors.push({
          actual: caseResult?.[field] ?? null,
          expected,
          id: `case.${caseResult?.id ?? "unknown"}.${field}`,
        });
      }
    }

    if (
      !Array.isArray(caseResult?.citations) ||
      caseResult.citationCount !== caseResult.citations.length ||
      (expectedCase.shouldAbstain !== true &&
        derivedPassed &&
        caseResult.citations.length === 0)
    ) {
      errors.push({
        actual: {
          citationCount: caseResult?.citationCount ?? null,
          citationsLength: caseResult?.citations?.length ?? null,
        },
        expected: "matching citation count and citation array",
        id: `case.${caseResult?.id ?? "unknown"}.citations`,
      });
    }

    if (
      !Number.isFinite(caseResult?.responseTimeMs) ||
      caseResult.responseTimeMs < 0
    ) {
      errors.push({
        actual: caseResult?.responseTimeMs ?? null,
        expected: "finite non-negative response time",
        id: `case.${caseResult?.id ?? "unknown"}.responseTimeMs`,
      });
    }

    derivedCases.push({
      ...caseResult,
      answerExpectationHit,
      abstained: derivedAbstained,
      claimSupportHit: derivedClaimSupportHit,
      docCoverageHit: coverage.docCoverageHit,
      pageCoverageHit: coverage.pageCoverageHit,
      passed: derivedPassed,
      shouldAbstain: expectedCase.shouldAbstain,
      type: expectedCase.type,
    });
  }

  const qaCases = derivedCases.filter(
    (caseResult) =>
      caseResult?.type === "qa" && caseResult.shouldAbstain !== true
  );
  const compareCases = derivedCases.filter(
    (caseResult) =>
      caseResult?.type === "compare" && caseResult.shouldAbstain !== true
  );
  const abstainCases = derivedCases.filter(
    (caseResult) => caseResult?.shouldAbstain === true
  );
  const nonAbstainCases = derivedCases.filter(
    (caseResult) => caseResult?.shouldAbstain !== true
  );
  const uploads = toArray(report?.uploads);
  const successfulUploads = uploads.filter(
    (upload) =>
      upload?.mergedMatchesOriginal === true &&
      Number(upload?.skippedChunksOnResume) > 0
  );
  const expectedMetrics = {
    overallPassRate: ratio(
      derivedCases.filter((caseResult) => caseResult?.passed === true).length,
      derivedCases.length
    ),
    qaPageHitRate: ratio(
      qaCases.filter((caseResult) => caseResult?.pageCoverageHit === true)
        .length,
      qaCases.length
    ),
    compareDocCoverageRate: ratio(
      compareCases.filter((caseResult) => caseResult?.docCoverageHit === true)
        .length,
      compareCases.length
    ),
    comparePageHitRate: ratio(
      compareCases.filter((caseResult) => caseResult?.pageCoverageHit === true)
        .length,
      compareCases.length
    ),
    abstainAccuracy: ratio(
      abstainCases.filter((caseResult) => caseResult?.abstained === true).length,
      abstainCases.length
    ),
    answerContentHitRate: ratio(
      nonAbstainCases.filter(
        (caseResult) => caseResult?.answerExpectationHit === true
      ).length,
      nonAbstainCases.length
    ),
    claimSupportHitRate: ratio(
      nonAbstainCases.filter(
        (caseResult) => caseResult?.claimSupportHit === true
      ).length,
      nonAbstainCases.length
    ),
    uploadResumeSuccessRate: ratio(successfulUploads.length, uploads.length),
    averageResponseTimeMs: average(
      derivedCases.map((caseResult) => caseResult?.responseTimeMs)
    ),
    averageCitationCount: average(
      derivedCases.map((caseResult) => toArray(caseResult?.citations).length)
    ),
    totalSkippedBytesOnResume: uploads.reduce(
      (sum, upload) => sum + Number(upload?.skippedBytesOnResume ?? 0),
      0
    ),
  };
  const summary = report?.summary ?? {};
  const metrics = summary.metrics ?? {};
  const expectedCorpusSummary = {
    documents: corpusContract?.documentCount ?? null,
    cases: derivedCases.length,
    qaCases: qaCases.length,
    compareCases: compareCases.length,
    abstainCases: abstainCases.length,
  };

  for (const [metric, expected] of Object.entries(expectedMetrics)) {
    addMetricMismatch({
      actual: metrics[metric],
      errors,
      expected,
      metric: `metrics.${metric}`,
    });
  }

  for (const [metric, expected] of Object.entries(expectedCorpusSummary)) {
    addMetricMismatch({
      actual: summary.corpus?.[metric],
      errors,
      expected,
      metric: `corpus.${metric}`,
    });
  }

  addMetricMismatch({
    actual: summary.status,
    errors,
    expected:
      derivedCases.length > 0 &&
      derivedCases.every((caseResult) => caseResult.passed) &&
      expectedMetrics.uploadResumeSuccessRate === 1
        ? "pass"
        : "fail",
    metric: "status",
  });

  if (
    report?.documents?.length !== corpusContract?.documentCount ||
    uploads.length !== corpusContract?.documentCount
  ) {
    errors.push({
      actual: {
        documents: report?.documents?.length ?? null,
        uploads: uploads.length,
      },
      expected: {
        documents: corpusContract?.documentCount ?? null,
        uploads: corpusContract?.documentCount ?? null,
      },
      id: "raw.document_upload_count",
    });
  }

  return {
    errors,
    rawMetrics: expectedMetrics,
    resultPassed:
      cases.length > 0 &&
      derivedCases.every((caseResult) => caseResult.passed) &&
      expectedMetrics.uploadResumeSuccessRate === 1,
  };
};

const validateCaseContract = ({
  cases,
  corpusContract,
  manifest,
}) => {
  const errors = [];
  const normalizedCases = toArray(cases);
  const actualCaseIds = toIds(normalizedCases);
  const corpusCases = toArray(corpusContract?.cases);
  const expectedCaseIds =
    manifest.caseSource === "corpus"
      ? corpusCases.length > 0
        ? toIds(corpusCases)
        : toArray(corpusContract?.caseIds)
      : Object.keys(manifest.checksByCase ?? {});
  const duplicateCaseIds = findDuplicateIds(actualCaseIds);

  if (!Array.isArray(cases)) {
    errors.push({
      actual: typeof cases,
      expected: "array",
      id: "cases.array",
    });
  }

  if (actualCaseIds.some((id) => !id)) {
    errors.push({
      actual: actualCaseIds,
      expected: "non-empty unique case IDs",
      id: "cases.ids",
    });
  }

  if (duplicateCaseIds.length > 0) {
    errors.push({
      actual: duplicateCaseIds,
      expected: [],
      id: "cases.duplicate_ids",
    });
  }

  const missingCaseIds = difference(expectedCaseIds, actualCaseIds);
  const extraCaseIds = difference(actualCaseIds, expectedCaseIds);

  if (missingCaseIds.length > 0 || extraCaseIds.length > 0) {
    errors.push({
      actual: {
        extraCaseIds,
        missingCaseIds,
      },
      expected: expectedCaseIds,
      id: "cases.contract",
    });
  }

  const missingRequiredCaseIds = difference(
    manifest.requiredCaseIds ?? [],
    actualCaseIds
  );

  if (missingRequiredCaseIds.length > 0) {
    errors.push({
      actual: missingRequiredCaseIds,
      expected: [],
      id: "cases.required",
    });
  }

  if (manifest.kind === "checks") {
    for (const caseResult of normalizedCases) {
      const expectedCheckIds = manifest.checksByCase?.[caseResult?.id] ?? [];
      const checks = caseResult?.checks;
      const actualCheckIds = toIds(checks);
      const duplicateCheckIds = findDuplicateIds(actualCheckIds);
      const missingCheckIds = difference(expectedCheckIds, actualCheckIds);
      const extraCheckIds = difference(actualCheckIds, expectedCheckIds);

      if (!Array.isArray(checks) || checks.length === 0) {
        errors.push({
          actual: checks ?? null,
          expected: "non-empty check array",
          id: `case.${caseResult?.id ?? "unknown"}.checks`,
        });
      }

      if (
        actualCheckIds.some((id) => !id) ||
        duplicateCheckIds.length > 0 ||
        missingCheckIds.length > 0 ||
        extraCheckIds.length > 0
      ) {
        errors.push({
          actual: {
            duplicateCheckIds,
            extraCheckIds,
            missingCheckIds,
          },
          expected: expectedCheckIds,
          id: `case.${caseResult?.id ?? "unknown"}.check_contract`,
        });
      }
    }
  } else {
    const expectedCasesById = new Map(
      corpusCases.map((caseDefinition) => [
        caseDefinition.id,
        caseDefinition,
      ])
    );
    const corpusDocuments = toArray(corpusContract?.documents);
    const corpusDocumentKeys = corpusDocuments.map((document) =>
      normalizeText(document?.key)
    );
    const duplicateCorpusDocumentKeys = findDuplicateIds(
      corpusDocumentKeys
    );

    if (
      !Array.isArray(corpusContract?.cases) ||
      !Array.isArray(corpusContract?.documents) ||
      corpusContract?.documentCount !== corpusDocuments.length
    ) {
      errors.push({
        actual: {
          caseType: typeof corpusContract?.cases,
          documentCount: corpusContract?.documentCount ?? null,
          documentsLength: corpusDocuments.length,
          documentsType: typeof corpusContract?.documents,
        },
        expected: "complete corpus contract",
        id: "corpus.contract_shape",
      });
    }

    if (
      corpusDocumentKeys.some((key) => !key) ||
      duplicateCorpusDocumentKeys.length > 0
    ) {
      errors.push({
        actual: {
          duplicateDocumentKeys: duplicateCorpusDocumentKeys,
          documentKeys: corpusDocumentKeys,
        },
        expected: "non-empty unique corpus document keys",
        id: "corpus.document_ids",
      });
    }

    const corpusDocumentsByKey = new Map(
      corpusDocuments.map((document) => [
        normalizeText(document?.key),
        {
          fileName: normalizeText(document?.fileName),
          pageCount: document?.pageCount,
          pages: toArray(document?.pages).map((page) =>
            normalizeText(page)
          ),
        },
      ])
    );

    for (const [documentKey, requiredDocument] of Object.entries(
      manifest.requiredDocuments ?? {}
    )) {
      const actualDocument = corpusDocumentsByKey.get(documentKey) ?? null;
      const expectedDocument = {
        fileName: normalizeText(requiredDocument?.fileName),
        pageCount: requiredDocument?.pageCount,
        pages: toArray(requiredDocument?.pages).map((page) =>
          normalizeText(page)
        ),
      };

      if (
        JSON.stringify(actualDocument) !==
        JSON.stringify(expectedDocument)
      ) {
        errors.push({
          actual: actualDocument,
          expected: expectedDocument,
          id: `corpus.document.${documentKey}.semantics`,
        });
      }
    }

    for (const [caseId, requiredSemantics] of Object.entries(
      manifest.requiredCaseSemantics ?? {}
    )) {
      const actualSemantics = normalizeCaseSemantics(
        expectedCasesById.get(caseId)
      );
      const expectedSemantics = normalizeCaseSemantics(
        requiredSemantics
      );

      if (
        JSON.stringify(actualSemantics) !==
        JSON.stringify(expectedSemantics)
      ) {
        errors.push({
          actual: actualSemantics,
          expected: expectedSemantics,
          id: `corpus.case.${caseId}.semantics`,
        });
      }
    }

    for (const caseResult of normalizedCases) {
      const expectedCase = expectedCasesById.get(caseResult?.id);

      if (!expectedCase) {
        continue;
      }

      const actualSemantics = {
        docKeys: toArray(caseResult.docKeys),
        question: normalizeText(caseResult.question),
        shouldAbstain: caseResult.shouldAbstain,
        type: caseResult.type,
      };
      const expectedSemantics = {
        docKeys: toArray(expectedCase.docKeys),
        question: normalizeText(expectedCase.question),
        shouldAbstain: expectedCase.shouldAbstain,
        type: expectedCase.type,
      };

      if (JSON.stringify(actualSemantics) !== JSON.stringify(expectedSemantics)) {
        errors.push({
          actual: actualSemantics,
          expected: expectedSemantics,
          id: `case.${caseResult.id}.semantics`,
        });
      }
    }
  }

  return {
    actualCaseIds,
    errors,
    expectedCaseIds,
  };
};

export const validateCurrentQualitySuiteReport = ({
  corpusContract = null,
  report = null,
  specId,
} = {}) => {
  const manifest = CURRENT_QUALITY_SUITE_MANIFEST[specId];

  if (!manifest) {
    return {
      actual: null,
      contractErrors: [
        {
          actual: specId ?? null,
          expected: "registered current quality suite",
          id: "manifest.missing",
        },
      ],
      expected: null,
      integrityErrors: [],
      manifestVersion: CURRENT_QUALITY_SUITE_MANIFEST_VERSION,
      resultPassed: false,
    };
  }

  const rawCases = report?.cases;
  const cases = toArray(rawCases);
  const contractValidation = validateCaseContract({
    cases: rawCases,
    corpusContract,
    manifest,
  });
  const integrityValidation =
    manifest.kind === "checks"
      ? validateCheckSuiteIntegrity({
          cases,
          manifest,
          report,
          specId,
        })
      : validateSyntheticIntegrity({
          cases,
          corpusContract,
          manifest,
          report,
        });
  const rawMetrics =
    integrityValidation.rawMetrics ?? buildRawCaseMetrics(cases);
  const rawResultPassed =
    manifest.kind === "checks"
      ? rawMetrics.caseCount > 0 &&
        rawMetrics.checkCount > 0 &&
        rawMetrics.failedCaseCount === 0 &&
        rawMetrics.failedCheckCount === 0
      : integrityValidation.resultPassed;
  const integrityErrors = [
    ...validateReportEnvelopeIntegrity(report),
    ...integrityValidation.errors,
  ];
  const resultPassed =
    rawResultPassed &&
    contractValidation.errors.length === 0 &&
    integrityErrors.length === 0;

  return {
    actual: {
      caseIds: contractValidation.actualCaseIds,
      rawMetrics,
    },
    contractErrors: contractValidation.errors,
    expected: {
      caseIds: contractValidation.expectedCaseIds,
      checksByCase: manifest.checksByCase ?? null,
      requiredCaseIds: manifest.requiredCaseIds ?? [],
    },
    integrityErrors,
    manifestVersion: CURRENT_QUALITY_SUITE_MANIFEST_VERSION,
    resultPassed,
  };
};
