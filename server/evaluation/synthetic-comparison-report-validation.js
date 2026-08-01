import {
  SYNTHETIC_COMPARE_EXPECTATIONS,
} from "./synthetic-case-verdict.js";

const RATE_PRECISION = 4;
const RATE_EPSILON = 0.000001;

export const SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES = Object.freeze({
  ok: "ok",
  inconsistent: "comparison_semantics_inconsistent",
  verdictExpectationMismatch: "comparison_verdict_expectation_mismatch",
  verdictActualMismatch: "comparison_verdict_actual_mismatch",
  verdictPassedMismatch: "comparison_verdict_passed_mismatch",
  verdictReasonCodeMismatch: "comparison_verdict_reason_code_mismatch",
  verdictNotChecked: "comparison_verdict_not_checked",
  verdictCheckedMismatch: "comparison_verdict_checked_mismatch",
  verdictPassedInvalid: "comparison_verdict_passed_invalid",
  expectationHitInvalid: "comparison_expectation_hit_invalid",
  verdictHitMismatch: "comparison_verdict_hit_mismatch",
  rawClaimSupportHitMismatch:
    "comparison_raw_claim_support_hit_mismatch",
  caseBooleanInvalid: "comparison_case_boolean_invalid",
  casePassedInvalid: "comparison_case_passed_invalid",
  casePassMismatch: "comparison_case_pass_mismatch",
  hitRateInvalid: "comparison_expectation_hit_rate_invalid",
  hitRateMismatch: "comparison_expectation_hit_rate_mismatch",
  comparisonCaseRequired: "comparison_case_required",
  expectationInvalid: "comparison_expectation_invalid",
});

const hasCompareExpectation = (caseResult = {}) =>
  caseResult.compareExpectation !== null &&
  caseResult.compareExpectation !== undefined;

const hasValidCompareExpectation = (caseResult = {}) =>
  SYNTHETIC_COMPARE_EXPECTATIONS.includes(caseResult.compareExpectation);

const REQUIRED_CASE_BOOLEAN_FIELDS = Object.freeze([
  "shouldAbstain",
  "abstained",
  "docCoverageHit",
  "pageCoverageHit",
  "answerExpectationHit",
  "claimSupportHit",
  "rawClaimSupportHit",
]);

const toHitRate = (hitCount, caseCount) =>
  caseCount === 0
    ? null
    : Number((hitCount / caseCount).toFixed(RATE_PRECISION));

const buildIssue = ({
  actual,
  caseId = null,
  expected,
  field = null,
  reasonCode,
}) => ({
  reasonCode,
  caseId,
  ...(field ? { field } : {}),
  expected: expected ?? null,
  actual: actual ?? null,
});

export const validateSyntheticComparisonSemantics = (
  payload = {},
  { caseOutcomeContract = null, requireComparisonCases = false } = {}
) => {
  const outcomes = caseOutcomeContract?.outcomes ?? [];
  const typedComparisonCases = outcomes.filter(
    (outcome) => outcome.caseContract?.type === "compare"
  );
  const comparisonCases = requireComparisonCases
    ? typedComparisonCases
    : outcomes.filter((outcome) =>
        hasCompareExpectation(outcome.caseContract)
      );
  const issues = [];

  if (requireComparisonCases && typedComparisonCases.length === 0) {
    issues.push(
      buildIssue({
        actual: 0,
        expected: ">= 1",
        reasonCode:
          SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.comparisonCaseRequired,
      })
    );
  }

  for (const outcome of comparisonCases) {
    const caseResult = outcome.caseResult;
    const caseContract = outcome.caseContract;

    if (!hasValidCompareExpectation(caseContract)) {
      issues.push(
        buildIssue({
          actual: caseContract?.compareExpectation,
          caseId: caseResult?.id,
          expected: SYNTHETIC_COMPARE_EXPECTATIONS.join(" | "),
          field: "compareExpectation",
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.expectationInvalid,
        })
      );
    }
  }

  const evaluatedComparisonCases = comparisonCases
    .filter((outcome) => hasValidCompareExpectation(outcome.caseContract))
    .map((outcome) => ({
      caseResult: outcome.caseResult,
      expectedVerdict: outcome.comparisonVerdict,
      expectedRawClaimSupportHit: outcome.rawClaimSupportHit,
      expectedCasePassed: outcome.passed,
    }));

  for (const {
    caseResult,
    expectedVerdict,
    expectedRawClaimSupportHit,
    expectedCasePassed,
  } of evaluatedComparisonCases) {
    const caseId = caseResult.id ?? null;
    const verdict = caseResult.comparisonVerdict;
    const verdictPassed = verdict?.passed;
    const expectationHit = caseResult.comparisonExpectationHit;

    for (const field of REQUIRED_CASE_BOOLEAN_FIELDS) {
      if (typeof caseResult[field] !== "boolean") {
        issues.push(
          buildIssue({
            actual: caseResult[field],
            caseId,
            expected: "boolean",
            field,
            reasonCode:
              SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.caseBooleanInvalid,
          })
        );
      }
    }

    if (caseResult.rawClaimSupportHit !== expectedRawClaimSupportHit) {
      issues.push(
        buildIssue({
          actual: caseResult.rawClaimSupportHit,
          caseId,
          expected: expectedRawClaimSupportHit,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.rawClaimSupportHitMismatch,
        })
      );
    }

    if (verdict?.expected !== expectedVerdict.expected) {
      issues.push(
        buildIssue({
          actual: verdict?.expected,
          caseId,
          expected: expectedVerdict.expected,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictExpectationMismatch,
        })
      );
    }

    if (expectedVerdict.checked !== true) {
      issues.push(
        buildIssue({
          actual: expectedVerdict.checked,
          caseId,
          expected: true,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictNotChecked,
        })
      );
    }

    if (verdict?.checked !== expectedVerdict.checked) {
      issues.push(
        buildIssue({
          actual: verdict?.checked,
          caseId,
          expected: expectedVerdict.checked,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictCheckedMismatch,
        })
      );
    }

    if (verdict?.actual !== expectedVerdict.actual) {
      issues.push(
        buildIssue({
          actual: verdict?.actual,
          caseId,
          expected: expectedVerdict.actual,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictActualMismatch,
        })
      );
    }

    if (typeof verdictPassed !== "boolean") {
      issues.push(
        buildIssue({
          actual: verdictPassed,
          caseId,
          expected: "boolean",
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictPassedInvalid,
        })
      );
    }

    if (verdictPassed !== expectedVerdict.passed) {
      issues.push(
        buildIssue({
          actual: verdictPassed,
          caseId,
          expected: expectedVerdict.passed,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictPassedMismatch,
        })
      );
    }

    if (verdict?.reasonCode !== expectedVerdict.reasonCode) {
      issues.push(
        buildIssue({
          actual: verdict?.reasonCode,
          caseId,
          expected: expectedVerdict.reasonCode,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictReasonCodeMismatch,
        })
      );
    }

    if (typeof expectationHit !== "boolean") {
      issues.push(
        buildIssue({
          actual: expectationHit,
          caseId,
          expected: "boolean",
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.expectationHitInvalid,
        })
      );
    }

    if (
      typeof expectationHit === "boolean" &&
      expectedVerdict.passed !== expectationHit
    ) {
      issues.push(
        buildIssue({
          actual: expectationHit,
          caseId,
          expected: expectedVerdict.passed,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.verdictHitMismatch,
        })
      );
    }

    if (typeof caseResult.passed !== "boolean") {
      issues.push(
        buildIssue({
          actual: caseResult.passed,
          caseId,
          expected: "boolean",
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.casePassedInvalid,
        })
      );
    } else if (caseResult.passed !== expectedCasePassed) {
      issues.push(
        buildIssue({
          actual: caseResult.passed,
          caseId,
          expected: expectedCasePassed,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.casePassMismatch,
        })
      );
    }
  }

  const expectedHitRate = toHitRate(
    evaluatedComparisonCases.filter(
      ({ expectedVerdict }) => expectedVerdict.passed === true
    ).length,
    comparisonCases.length
  );
  const actualHitRate =
    payload.summary?.metrics?.comparisonExpectationHitRate;

  if (comparisonCases.length > 0) {
    if (typeof actualHitRate !== "number" || !Number.isFinite(actualHitRate)) {
      issues.push(
        buildIssue({
          actual: actualHitRate,
          expected: expectedHitRate,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.hitRateInvalid,
        })
      );
    } else if (Math.abs(actualHitRate - expectedHitRate) > RATE_EPSILON) {
      issues.push(
        buildIssue({
          actual: actualHitRate,
          expected: expectedHitRate,
          reasonCode:
            SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.hitRateMismatch,
        })
      );
    }
  }

  return {
    applicable: requireComparisonCases || comparisonCases.length > 0,
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0
        ? SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.ok
        : SYNTHETIC_COMPARISON_SEMANTIC_REASON_CODES.inconsistent,
    comparisonCaseCount: comparisonCases.length,
    comparisonHitCount: evaluatedComparisonCases.filter(
      ({ expectedVerdict }) => expectedVerdict.passed === true
    ).length,
    expectedHitRate,
    actualHitRate: actualHitRate ?? null,
    issues,
  };
};
