export const ROBUST_REPORT_CASE_REASON_CODES = Object.freeze({
  ok: "ok",
  invalid: "robust_case_contract_invalid",
  rawCasesMissing: "raw_cases_missing",
  rawCasesEmpty: "raw_cases_empty",
  rawCaseIdMissing: "raw_case_id_missing",
  rawCaseIdDuplicate: "raw_case_id_duplicate",
  rawCaseTypeMissing: "raw_case_type_missing",
  declaredCaseCountMissing: "declared_case_count_missing",
  summaryCaseCountMissing: "summary_case_count_missing",
  summaryCaseCountInvalid: "summary_case_count_invalid",
  summaryCaseCountMismatch: "summary_case_count_mismatch",
  corpusCaseCountInvalid: "corpus_case_count_invalid",
  corpusCaseCountMismatch: "corpus_case_count_mismatch",
});

const isNonNegativeInteger = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const buildIssue = ({ actual, expected, reasonCode }) => ({
  reasonCode,
  expected: expected ?? null,
  actual: actual ?? null,
});

const validateRawCaseIdentities = ({ issues, rawCases }) => {
  const seenIds = new Set();

  rawCases.forEach((caseResult, caseIndex) => {
    const id =
      typeof caseResult?.id === "string" ? caseResult.id.trim() : "";
    const type =
      typeof caseResult?.type === "string" ? caseResult.type.trim() : "";

    if (!id) {
      issues.push({
        ...buildIssue({
          actual: caseResult?.id,
          expected: "non-empty string",
          reasonCode: ROBUST_REPORT_CASE_REASON_CODES.rawCaseIdMissing,
        }),
        caseIndex,
      });
    } else if (seenIds.has(id)) {
      issues.push({
        ...buildIssue({
          actual: id,
          expected: "unique raw case id",
          reasonCode: ROBUST_REPORT_CASE_REASON_CODES.rawCaseIdDuplicate,
        }),
        caseIndex,
      });
    } else {
      seenIds.add(id);
    }

    if (!type) {
      issues.push({
        ...buildIssue({
          actual: caseResult?.type,
          expected: "non-empty string",
          reasonCode: ROBUST_REPORT_CASE_REASON_CODES.rawCaseTypeMissing,
        }),
        caseIndex,
      });
    }
  });
};

const validateDeclaredCount = ({
  expectedCount,
  issues,
  reasonCodeInvalid,
  reasonCodeMismatch,
  value,
}) => {
  if (!isNonNegativeInteger(value)) {
    issues.push(
      buildIssue({
        actual: value,
        expected: "non-negative integer",
        reasonCode: reasonCodeInvalid,
      })
    );
    return;
  }

  if (expectedCount !== null && value !== expectedCount) {
    issues.push(
      buildIssue({
        actual: value,
        expected: expectedCount,
        reasonCode: reasonCodeMismatch,
      })
    );
  }
};

export const validateRobustReportCaseContract = (
  payload = {},
  {
    expectedCorpusCaseCount = null,
    requireSummaryCaseCount = false,
  } = {}
) => {
  const summary = payload.summary;
  const corpus = summary?.corpus;
  const rawCases = payload.cases;
  const rawCaseCount = Array.isArray(rawCases) ? rawCases.length : null;
  const hasSummaryCaseCount = Object.hasOwn(summary ?? {}, "caseCount");
  const hasCorpusCaseCount = Object.hasOwn(corpus ?? {}, "cases");
  const issues = [];

  if (!Array.isArray(rawCases)) {
    issues.push(
      buildIssue({
        actual: rawCases,
        expected: "non-empty array",
        reasonCode: ROBUST_REPORT_CASE_REASON_CODES.rawCasesMissing,
      })
    );
  } else if (rawCases.length === 0) {
    issues.push(
      buildIssue({
        actual: 0,
        expected: "> 0",
        reasonCode: ROBUST_REPORT_CASE_REASON_CODES.rawCasesEmpty,
      })
    );
  } else {
    validateRawCaseIdentities({
      issues,
      rawCases,
    });
  }

  if (!hasSummaryCaseCount && !hasCorpusCaseCount) {
    issues.push(
      buildIssue({
        actual: null,
        expected: "summary.caseCount or summary.corpus.cases",
        reasonCode:
          ROBUST_REPORT_CASE_REASON_CODES.declaredCaseCountMissing,
      })
    );
  }

  if (requireSummaryCaseCount && !hasSummaryCaseCount) {
    issues.push(
      buildIssue({
        actual: null,
        expected: "summary.caseCount",
        reasonCode:
          ROBUST_REPORT_CASE_REASON_CODES.summaryCaseCountMissing,
      })
    );
  }

  if (hasSummaryCaseCount) {
    validateDeclaredCount({
      expectedCount: rawCaseCount,
      issues,
      reasonCodeInvalid:
        ROBUST_REPORT_CASE_REASON_CODES.summaryCaseCountInvalid,
      reasonCodeMismatch:
        ROBUST_REPORT_CASE_REASON_CODES.summaryCaseCountMismatch,
      value: summary.caseCount,
    });
  }

  if (hasCorpusCaseCount) {
    validateDeclaredCount({
      expectedCount: expectedCorpusCaseCount ?? rawCaseCount,
      issues,
      reasonCodeInvalid:
        ROBUST_REPORT_CASE_REASON_CODES.corpusCaseCountInvalid,
      reasonCodeMismatch:
        ROBUST_REPORT_CASE_REASON_CODES.corpusCaseCountMismatch,
      value: corpus.cases,
    });
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0
        ? ROBUST_REPORT_CASE_REASON_CODES.ok
        : ROBUST_REPORT_CASE_REASON_CODES.invalid,
    rawCaseCount,
    summaryCaseCount: hasSummaryCaseCount ? summary.caseCount : null,
    corpusCaseCount: hasCorpusCaseCount ? corpus.cases : null,
    issues,
  };
};
