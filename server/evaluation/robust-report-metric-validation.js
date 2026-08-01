export const ROBUST_REPORT_METRIC_REASON_CODES = Object.freeze({
  ok: "ok",
  invalid: "robust_metric_contract_invalid",
  rawCasesUnavailable: "raw_cases_unavailable_for_metric_recompute",
  syntheticCasePassedInvalid: "synthetic_case_passed_invalid",
  syntheticOverallPassRateInvalid: "synthetic_overall_pass_rate_invalid",
  syntheticOverallPassRateMismatch: "synthetic_overall_pass_rate_mismatch",
  rerankCaseMetricInvalid: "rerank_case_metric_invalid",
  rerankSummaryMetricInvalid: "rerank_summary_metric_invalid",
  rerankSummaryMetricMismatch: "rerank_summary_metric_mismatch",
});

const epsilon = 0.000001;

const round = (value, precision = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(precision)) : null;

const valuesMatch = (actual, expected) =>
  actual === expected ||
  (Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <= epsilon);

const buildIssue = ({
  actual,
  caseId = null,
  caseIndex = null,
  expected,
  path,
  reasonCode,
}) => ({
  reasonCode,
  path,
  ...(caseId ? { caseId } : {}),
  ...(caseIndex !== null ? { caseIndex } : {}),
  expected: expected ?? null,
  actual: actual ?? null,
});

const buildResult = ({ issues, metrics }) => ({
  status: issues.length === 0 ? "pass" : "fail",
  reasonCode:
    issues.length === 0
      ? ROBUST_REPORT_METRIC_REASON_CODES.ok
      : ROBUST_REPORT_METRIC_REASON_CODES.invalid,
  metrics,
  issues,
});

const isUnitMetric = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const validateReportedMetric = ({
  actual,
  expected,
  issues,
  path,
  unit = false,
}) => {
  const isValid =
    expected === null
      ? actual === null
      : unit
        ? isUnitMetric(actual)
        : typeof actual === "number" && Number.isFinite(actual);

  if (!isValid) {
    issues.push(
      buildIssue({
        actual,
        expected: expected === null ? null : unit ? "number in [0, 1]" : "finite number",
        path,
        reasonCode: ROBUST_REPORT_METRIC_REASON_CODES.rerankSummaryMetricInvalid,
      })
    );
    return;
  }

  if (!valuesMatch(actual, expected)) {
    issues.push(
      buildIssue({
        actual,
        expected,
        path,
        reasonCode: ROBUST_REPORT_METRIC_REASON_CODES.rerankSummaryMetricMismatch,
      })
    );
  }
};

export const validateSyntheticMetricContract = (
  payload = {},
  { caseOutcomeContract = null } = {}
) => {
  const rawCases = payload.cases;
  const issues = [];

  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    issues.push(
      buildIssue({
        actual: Array.isArray(rawCases) ? rawCases.length : rawCases,
        expected: "non-empty raw cases",
        path: "cases",
        reasonCode: ROBUST_REPORT_METRIC_REASON_CODES.rawCasesUnavailable,
      })
    );

    return buildResult({
      issues,
      metrics: {
        overallPassRate: null,
      },
    });
  }

  const recomputedOutcomes = caseOutcomeContract?.outcomes ?? [];

  if (caseOutcomeContract?.issues?.length > 0) {
    issues.push(...caseOutcomeContract.issues);
  }

  const recomputedOutcomesAvailable =
    recomputedOutcomes.length === rawCases.length;
  const overallPassRate = recomputedOutcomesAvailable
    ? round(
        recomputedOutcomes.filter((outcome) => outcome.passed === true).length /
          recomputedOutcomes.length
      )
    : null;
  const reportedPassRate = payload.summary?.metrics?.overallPassRate;

  if (!isUnitMetric(reportedPassRate)) {
    issues.push(
      buildIssue({
        actual: reportedPassRate,
        expected: "number in [0, 1]",
        path: "summary.metrics.overallPassRate",
        reasonCode:
          ROBUST_REPORT_METRIC_REASON_CODES.syntheticOverallPassRateInvalid,
      })
    );
  } else if (
    overallPassRate !== null &&
    !valuesMatch(reportedPassRate, overallPassRate)
  ) {
    issues.push(
      buildIssue({
        actual: reportedPassRate,
        expected: overallPassRate,
        path: "summary.metrics.overallPassRate",
        reasonCode:
          ROBUST_REPORT_METRIC_REASON_CODES.syntheticOverallPassRateMismatch,
      })
    );
  }

  return buildResult({
    issues,
    metrics: {
      overallPassRate,
    },
  });
};

const rerankMetricNames = [
  "ndcgAtK",
  "precisionAtK",
  "recallAtK",
  "mrr",
  "noiseRateAtK",
  "relevantCountAtK",
  "noiseCountAtK",
  "expectedRelevantCount",
  "evaluatedCountAtK",
];
const rerankLiftMetricNames = [
  "ndcgAtK",
  "precisionAtK",
  "recallAtK",
  "mrr",
];

export const validateRerankMetricContract = (
  payload = {},
  { rankingContract = null } = {}
) => {
  const issues = [];
  const recomputedMetrics = rankingContract?.metrics ?? null;

  if (!recomputedMetrics) {
    issues.push(
      buildIssue({
        actual: rankingContract?.status ?? null,
        expected: "valid independently recomputed raw rankings",
        path: "cases[*].baselineRanking|rerankedRanking",
        reasonCode: ROBUST_REPORT_METRIC_REASON_CODES.rawCasesUnavailable,
      })
    );

    return buildResult({
      issues,
      metrics: {
        baseline: null,
        reranked: null,
        lift: null,
        noiseFilteringRate: null,
      },
    });
  }

  const {
    averageCandidateCount,
    baseline,
    lift,
    noiseFilteringRate,
    reranked,
  } = recomputedMetrics;

  for (const group of ["baseline", "reranked"]) {
    for (const metric of rerankMetricNames) {
      validateReportedMetric({
        actual: payload.summary?.metrics?.[group]?.[metric],
        expected: group === "baseline" ? baseline[metric] : reranked[metric],
        issues,
        path: `summary.metrics.${group}.${metric}`,
      });
    }
  }

  validateReportedMetric({
    actual: payload.summary?.metrics?.noiseFilteringRate,
    expected: noiseFilteringRate,
    issues,
    path: "summary.metrics.noiseFilteringRate",
  });
  validateReportedMetric({
    actual: payload.summary?.metrics?.averageCandidateCount,
    expected: averageCandidateCount,
    issues,
    path: "summary.metrics.averageCandidateCount",
  });

  for (const metric of rerankLiftMetricNames) {
    for (const component of ["absolute", "relative"]) {
      validateReportedMetric({
        actual: payload.summary?.metrics?.lift?.[metric]?.[component],
        expected: lift[metric][component],
        issues,
        path: `summary.metrics.lift.${metric}.${component}`,
      });
    }
  }

  for (const component of ["absoluteReduction", "relativeReduction"]) {
    validateReportedMetric({
      actual:
        payload.summary?.metrics?.lift?.noiseRateAtK?.[component],
      expected: lift.noiseRateAtK[component],
      issues,
      path: `summary.metrics.lift.noiseRateAtK.${component}`,
    });
  }

  return buildResult({
    issues,
    metrics: {
      baseline,
      reranked,
      lift,
      noiseFilteringRate,
      averageCandidateCount,
    },
  });
};
