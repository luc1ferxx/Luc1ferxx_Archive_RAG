import {
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROBUST_REPORT_CORPUS_REASON_CODES = Object.freeze({
  ok: "ok",
  invalid: "robust_corpus_case_binding_invalid",
  unsafePath: "corpus_path_unsafe",
  readFailed: "corpus_read_failed",
  parseFailed: "corpus_parse_failed",
  casesInvalid: "corpus_cases_invalid",
  documentsInvalid: "corpus_documents_invalid",
  corpusCaseIdInvalid: "corpus_case_id_invalid",
  corpusCaseIdDuplicate: "corpus_case_id_duplicate",
  corpusCaseTypeInvalid: "corpus_case_type_invalid",
  corpusShouldAbstainInvalid: "corpus_should_abstain_invalid",
  reportCasesInvalid: "report_cases_invalid",
  reportCaseIdInvalid: "report_case_id_invalid",
  reportCaseIdDuplicate: "report_case_id_duplicate",
  corpusCaseMissing: "corpus_case_missing",
  reportCaseExtra: "report_case_extra",
  reportCaseTypeMismatch: "report_case_type_mismatch",
  reportCaseExpectationMismatch: "report_case_expectation_mismatch",
  skippedCasesInvalid: "skipped_cases_invalid",
  skippedCaseIdInvalid: "skipped_case_id_invalid",
  skippedCaseIdDuplicate: "skipped_case_id_duplicate",
  skippedCaseMissing: "skipped_case_missing",
  skippedCaseExtra: "skipped_case_extra",
  skippedCaseReasonMismatch: "skipped_case_reason_mismatch",
  reportTypeUnsupported: "robust_report_type_unsupported",
});

const evaluationDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(evaluationDirectory);

const buildIssue = ({
  actual,
  caseId = null,
  expected,
  field = null,
  reasonCode,
}) => ({
  reasonCode,
  ...(caseId ? { caseId } : {}),
  ...(field ? { field } : {}),
  expected: expected ?? null,
  actual: actual ?? null,
});

const isPathWithin = (parentPath, candidatePath) => {
  const relativePath = path.relative(parentPath, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
};

const readConfiguredCorpus = (report) => {
  if (
    typeof report?.corpusPath !== "string" ||
    report.corpusPath.trim().length === 0
  ) {
    return {
      issue: buildIssue({
        actual: report?.corpusPath,
        expected: "configured evaluation corpus path",
        field: "report.corpusPath",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.unsafePath,
      }),
    };
  }

  const configuredPath = path.resolve(serverDirectory, report.corpusPath);

  if (!isPathWithin(evaluationDirectory, configuredPath)) {
    return {
      issue: buildIssue({
        actual: report.corpusPath,
        expected: "path inside server/evaluation",
        field: "report.corpusPath",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.unsafePath,
      }),
    };
  }

  let realCorpusPath;

  try {
    realCorpusPath = realpathSync(configuredPath);
  } catch {
    return {
      issue: buildIssue({
        actual: report.corpusPath,
        expected: "readable configured corpus",
        field: "report.corpusPath",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.readFailed,
      }),
    };
  }

  let realEvaluationDirectory;

  try {
    realEvaluationDirectory = realpathSync(evaluationDirectory);
  } catch {
    return {
      issue: buildIssue({
        actual: "evaluation directory unavailable",
        expected: "readable server/evaluation directory",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.readFailed,
      }),
    };
  }

  if (!isPathWithin(realEvaluationDirectory, realCorpusPath)) {
    return {
      issue: buildIssue({
        actual: report.corpusPath,
        expected: "non-escaping evaluation corpus path",
        field: "report.corpusPath",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.unsafePath,
      }),
    };
  }

  let rawCorpus;

  try {
    rawCorpus = readFileSync(realCorpusPath, "utf8");
  } catch {
    return {
      issue: buildIssue({
        actual: report.corpusPath,
        expected: "readable configured corpus",
        field: "report.corpusPath",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.readFailed,
      }),
    };
  }

  try {
    return {
      corpus: JSON.parse(rawCorpus),
    };
  } catch {
    return {
      issue: buildIssue({
        actual: report.corpusPath,
        expected: "valid JSON corpus",
        field: "report.corpusPath",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.parseFailed,
      }),
    };
  }
};

const getCaseId = (caseResult) =>
  typeof caseResult?.id === "string" ? caseResult.id.trim() : "";

const toCaseContract = (caseResult = {}, corpusIdentity = {}) => ({
  id: caseResult.id,
  type: caseResult.type,
  question: caseResult.question,
  corpusId: corpusIdentity.id,
  corpusVersion: corpusIdentity.version,
  shouldAbstain: caseResult.shouldAbstain,
  compareExpectation: caseResult.compareExpectation,
  docKeys: Array.isArray(caseResult.docKeys)
    ? [...caseResult.docKeys]
    : caseResult.docKeys,
  expectedEvidence: Array.isArray(caseResult.expectedEvidence)
    ? caseResult.expectedEvidence.map((expected) => ({
        ...expected,
        pages: Array.isArray(expected?.pages)
          ? [...expected.pages]
          : expected?.pages,
      }))
    : caseResult.expectedEvidence,
  expectedAnswerIncludes: Array.isArray(caseResult.expectedAnswerIncludes)
    ? [...caseResult.expectedAnswerIncludes]
    : caseResult.expectedAnswerIncludes,
});

const toDocumentContract = (document = {}) => ({
  key: document.key,
  fileName: document.fileName,
  pages: Array.isArray(document.pages) ? [...document.pages] : document.pages,
});

export const loadRobustReportCaseContracts = (report = {}) => {
  const readResult = readConfiguredCorpus(report);

  if (readResult.issue) {
    return {
      issue: readResult.issue,
      caseContracts: [],
      documentContracts: [],
      corpusCaseCount: null,
    };
  }

  const corpusCases = readResult.corpus?.cases;
  const corpusDocuments = readResult.corpus?.documents;

  if (!Array.isArray(corpusCases)) {
    return {
      issue: buildIssue({
        actual: corpusCases,
        expected: "array",
        field: "corpus.cases",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.casesInvalid,
      }),
      caseContracts: [],
      documentContracts: [],
      corpusCaseCount: null,
    };
  }

  if (!Array.isArray(corpusDocuments)) {
    return {
      issue: buildIssue({
        actual: corpusDocuments,
        expected: "array",
        field: "corpus.documents",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.documentsInvalid,
      }),
      caseContracts: [],
      documentContracts: [],
      corpusCaseCount: null,
    };
  }

  return {
    issue: null,
    caseContracts: corpusCases.map((caseResult) =>
      toCaseContract(caseResult, {
        id: readResult.corpus?.id,
        version: readResult.corpus?.version,
      })
    ),
    documentContracts: corpusDocuments.map(toDocumentContract),
    corpusCaseCount: corpusCases.length,
  };
};

const validateCorpusCases = (corpusCases, issues) => {
  const casesById = new Map();

  corpusCases.forEach((caseResult) => {
    const id = getCaseId(caseResult);

    if (!id) {
      issues.push(
        buildIssue({
          actual: caseResult?.id,
          expected: "non-empty string",
          field: "id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.corpusCaseIdInvalid,
        })
      );
      return;
    }

    if (casesById.has(id)) {
      issues.push(
        buildIssue({
          actual: id,
          caseId: id,
          expected: "unique corpus case id",
          field: "id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.corpusCaseIdDuplicate,
        })
      );
      return;
    }

    casesById.set(id, caseResult);

    if (
      typeof caseResult?.type !== "string" ||
      caseResult.type.trim().length === 0
    ) {
      issues.push(
        buildIssue({
          actual: caseResult?.type,
          caseId: id,
          expected: "non-empty string",
          field: "type",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.corpusCaseTypeInvalid,
        })
      );
    }

    if (typeof caseResult?.shouldAbstain !== "boolean") {
      issues.push(
        buildIssue({
          actual: caseResult?.shouldAbstain,
          caseId: id,
          expected: "boolean",
          field: "shouldAbstain",
          reasonCode:
            ROBUST_REPORT_CORPUS_REASON_CODES.corpusShouldAbstainInvalid,
        })
      );
    }
  });

  return casesById;
};

const validateReportCases = ({ expectedCases, issues, payload }) => {
  const reportCases = payload.cases;

  if (!Array.isArray(reportCases)) {
    issues.push(
      buildIssue({
        actual: reportCases,
        expected: "array",
        field: "cases",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.reportCasesInvalid,
      })
    );
    return;
  }

  const expectedById = new Map(
    expectedCases.map((caseResult) => [getCaseId(caseResult), caseResult])
  );
  const reportCaseCounts = new Map();

  for (const caseResult of reportCases) {
    const id = getCaseId(caseResult);

    if (!id) {
      issues.push(
        buildIssue({
          actual: caseResult?.id,
          expected: "non-empty string",
          field: "id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.reportCaseIdInvalid,
        })
      );
      continue;
    }

    const nextCount = (reportCaseCounts.get(id) ?? 0) + 1;
    reportCaseCounts.set(id, nextCount);

    if (nextCount > 1) {
      issues.push(
        buildIssue({
          actual: id,
          caseId: id,
          expected: "unique report case id",
          field: "id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.reportCaseIdDuplicate,
        })
      );
      continue;
    }

    const expectedCase = expectedById.get(id);

    if (!expectedCase) {
      issues.push(
        buildIssue({
          actual: id,
          caseId: id,
          expected: "case id from configured corpus",
          field: "id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.reportCaseExtra,
        })
      );
      continue;
    }

    if (caseResult.type !== expectedCase.type) {
      issues.push(
        buildIssue({
          actual: caseResult.type,
          caseId: id,
          expected: expectedCase.type,
          field: "type",
          reasonCode:
            ROBUST_REPORT_CORPUS_REASON_CODES.reportCaseTypeMismatch,
        })
      );
    }

    if (
      (caseResult.compareExpectation ?? null) !==
      (expectedCase.compareExpectation ?? null)
    ) {
      issues.push(
        buildIssue({
          actual: caseResult.compareExpectation,
          caseId: id,
          expected: expectedCase.compareExpectation,
          field: "compareExpectation",
          reasonCode:
            ROBUST_REPORT_CORPUS_REASON_CODES.reportCaseExpectationMismatch,
        })
      );
    }
  }

  for (const expectedCase of expectedCases) {
    const id = getCaseId(expectedCase);

    if ((reportCaseCounts.get(id) ?? 0) === 0) {
      issues.push(
        buildIssue({
          actual: null,
          caseId: id,
          expected: id,
          field: "id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.corpusCaseMissing,
        })
      );
    }
  }
};

const validateSkippedCases = ({ corpusCases, issues, payload }) => {
  const expectedSkippedCases = corpusCases.filter(
    (caseResult) => caseResult.shouldAbstain === true
  );
  const expectedById = new Map(
    expectedSkippedCases.map((caseResult) => [getCaseId(caseResult), caseResult])
  );
  const skippedCases = payload.skippedCases;

  if (!Array.isArray(skippedCases)) {
    issues.push(
      buildIssue({
        actual: skippedCases,
        expected: "array",
        field: "skippedCases",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.skippedCasesInvalid,
      })
    );
    return expectedSkippedCases.length;
  }

  const skippedCaseCounts = new Map();

  for (const skippedCase of skippedCases) {
    const id = getCaseId(skippedCase);

    if (!id) {
      issues.push(
        buildIssue({
          actual: skippedCase?.id,
          expected: "non-empty string",
          field: "skippedCases.id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.skippedCaseIdInvalid,
        })
      );
      continue;
    }

    const nextCount = (skippedCaseCounts.get(id) ?? 0) + 1;
    skippedCaseCounts.set(id, nextCount);

    if (nextCount > 1) {
      issues.push(
        buildIssue({
          actual: id,
          caseId: id,
          expected: "unique skipped case id",
          field: "skippedCases.id",
          reasonCode:
            ROBUST_REPORT_CORPUS_REASON_CODES.skippedCaseIdDuplicate,
        })
      );
      continue;
    }

    if (!expectedById.has(id)) {
      issues.push(
        buildIssue({
          actual: id,
          caseId: id,
          expected: "shouldAbstain case id from configured corpus",
          field: "skippedCases.id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.skippedCaseExtra,
        })
      );
    }

    if (skippedCase.reason !== "abstain_case") {
      issues.push(
        buildIssue({
          actual: skippedCase.reason,
          caseId: id,
          expected: "abstain_case",
          field: "skippedCases.reason",
          reasonCode:
            ROBUST_REPORT_CORPUS_REASON_CODES.skippedCaseReasonMismatch,
        })
      );
    }
  }

  for (const expectedCase of expectedSkippedCases) {
    const id = getCaseId(expectedCase);

    if ((skippedCaseCounts.get(id) ?? 0) === 0) {
      issues.push(
        buildIssue({
          actual: null,
          caseId: id,
          expected: id,
          field: "skippedCases.id",
          reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.skippedCaseMissing,
        })
      );
    }
  }

  return expectedSkippedCases.length;
};

export const validateRobustReportCorpusBinding = ({
  payload = {},
  report = {},
} = {}) => {
  const contractResult = loadRobustReportCaseContracts(report);
  const issues = [];

  if (contractResult.issue) {
    issues.push(contractResult.issue);
    return {
      status: "fail",
      reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.invalid,
      corpusCaseCount: null,
      expectedEvaluatedCaseCount: null,
      expectedSkippedCaseCount: null,
      caseContracts: [],
      documentContracts: [],
      issues,
    };
  }

  const corpusCases = contractResult.caseContracts;

  validateCorpusCases(corpusCases, issues);

  let expectedCases;
  let expectedSkippedCaseCount = 0;

  if (report.reportType === "synthetic") {
    expectedCases = corpusCases;
  } else if (report.reportType === "rerank") {
    expectedCases = corpusCases.filter(
      (caseResult) => caseResult.shouldAbstain !== true
    );
    expectedSkippedCaseCount = validateSkippedCases({
      corpusCases,
      issues,
      payload,
    });
  } else {
    issues.push(
      buildIssue({
        actual: report.reportType,
        expected: "synthetic | rerank",
        field: "report.reportType",
        reasonCode: ROBUST_REPORT_CORPUS_REASON_CODES.reportTypeUnsupported,
      })
    );
    expectedCases = [];
  }

  validateReportCases({
    expectedCases,
    issues,
    payload,
  });

  return {
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0
        ? ROBUST_REPORT_CORPUS_REASON_CODES.ok
        : ROBUST_REPORT_CORPUS_REASON_CODES.invalid,
    corpusCaseCount: corpusCases.length,
    expectedEvaluatedCaseCount: expectedCases.length,
    expectedSkippedCaseCount,
    caseContracts: corpusCases,
    documentContracts: contractResult.documentContracts,
    issues,
  };
};
