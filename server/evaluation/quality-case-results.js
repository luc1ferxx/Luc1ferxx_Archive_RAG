const toArray = (value) => (Array.isArray(value) ? value : []);

const toNonNegativeNumber = (value, fallbackValue = 0) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
};

const compactFailedCheck = (check = {}) => ({
  id: check.id,
  label: check.label,
  category: check.category,
  detail: check.detail ?? null,
});

const summarizeCase = (caseResult = {}) => {
  const checks = toArray(caseResult.checks);
  const failedChecks = checks
    .filter((check) => check?.passed !== true)
    .map(compactFailedCheck);
  const failedCheckCount = Math.max(
    toNonNegativeNumber(caseResult.failedCheckCount),
    failedChecks.length
  );

  return {
    failed:
      caseResult.passed !== true ||
      failedCheckCount > 0,
    failedCase: {
      id: caseResult.id,
      label: caseResult.label,
      failedCheckCount,
      failedChecks,
    },
    failedCheckCount,
    checkCount: checks.length,
  };
};

export const summarizeQualityCaseResults = ({
  cases: inputCases = [],
  metrics = {},
} = {}) => {
  const cases = toArray(inputCases);
  const caseSummaries = cases.map(summarizeCase);
  const failedCases = caseSummaries
    .filter((caseSummary) => caseSummary.failed)
    .map((caseSummary) => caseSummary.failedCase);
  const rawFailedCheckCount = caseSummaries.reduce(
    (sum, caseSummary) => sum + caseSummary.failedCheckCount,
    0
  );
  const rawCheckCount = caseSummaries.reduce(
    (sum, caseSummary) => sum + caseSummary.checkCount,
    0
  );
  const failedCaseCount = Math.max(
    toNonNegativeNumber(metrics.failedCaseCount),
    failedCases.length
  );
  const failedCheckCount = Math.max(
    toNonNegativeNumber(metrics.failedCheckCount),
    rawFailedCheckCount
  );

  return {
    cases,
    failedCases,
    failedCaseCount,
    failedCheckCount,
    caseCount: Math.max(
      toNonNegativeNumber(metrics.caseCount),
      cases.length,
      failedCaseCount
    ),
    checkCount: Math.max(
      toNonNegativeNumber(metrics.checkCount),
      rawCheckCount,
      failedCheckCount
    ),
  };
};
