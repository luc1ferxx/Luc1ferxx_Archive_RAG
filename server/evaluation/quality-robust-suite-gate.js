import { robustEvalSuite } from "./eval-suite.js";
import { buildFailedCases } from "./quality-run-summary.js";
import {
  getCorpusName,
  getWorstStatus,
} from "./quality-shared.js";
import {
  validateRobustReportCaseContract,
} from "./robust-report-case-validation.js";
import {
  validateRobustReportCorpusBinding,
} from "./robust-report-corpus-validation.js";
import {
  validateRerankMetricContract,
  validateSyntheticMetricContract,
} from "./robust-report-metric-validation.js";
import {
  validateRerankReportRankings,
} from "./rerank-report-ranking-validation.js";
import {
  validateSyntheticComparisonSemantics,
} from "./synthetic-comparison-report-validation.js";
import {
  validateSyntheticCaseOutcomes,
} from "./synthetic-report-case-evaluator.js";

const epsilon = 0.000001;

const normalizePayloadEntries = (latestRobustPayloads = []) => {
  if (!latestRobustPayloads) {
    return new Map();
  }

  if (Array.isArray(latestRobustPayloads)) {
    return new Map(
      latestRobustPayloads
        .filter((entry) => entry?.reportId)
        .map((entry) => [entry.reportId, entry.payload ?? null])
    );
  }

  if (typeof latestRobustPayloads === "object") {
    return new Map(Object.entries(latestRobustPayloads));
  }

  return new Map();
};

const buildCheck = ({
  currentValue = null,
  detail = null,
  label,
  metric,
  report,
  status,
  threshold = null,
}) => ({
  metric,
  label,
  status,
  reportId: report.id,
  reportLabel: report.label,
  currentValue,
  threshold,
  detail,
});

const buildAvailabilityFailure = ({ report, required }) => {
  const status = required ? "fail" : "unknown";

  return {
    reportId: report.id,
    label: report.label,
    latestName: report.latestName,
    reportType: report.reportType,
    status,
    missing: true,
    checks: [
      buildCheck({
        label: `${report.label} report exists`,
        metric: "robustSuiteReportExists",
        report,
        status,
        detail: `${report.latestName}.json was not found.`,
      }),
    ],
  };
};

const buildCorpusCheck = ({ payload, report }) => {
  const expectedCorpusName = getCorpusName(report.corpusPath);
  const actualCorpusName = getCorpusName(payload.summary?.corpus?.path);
  const matched = expectedCorpusName === actualCorpusName;

  return buildCheck({
    label: `${report.label} corpus`,
    metric: "robustSuiteCorpusMatch",
    report,
    status: matched ? "pass" : "fail",
    currentValue: actualCorpusName,
    threshold: expectedCorpusName,
  });
};

const buildCaseContractCheck = ({ caseContract, report }) =>
  buildCheck({
    label: `${report.label} case contract`,
    metric: "robustSuiteCaseContract",
    report,
    status: caseContract.status,
    currentValue: {
      rawCaseCount: caseContract.rawCaseCount,
      summaryCaseCount: caseContract.summaryCaseCount,
      corpusCaseCount: caseContract.corpusCaseCount,
    },
    threshold: {
      rawCasesNonEmpty: true,
      declaredCountsMatchRawCases: true,
    },
    detail: {
      reasonCode: caseContract.reasonCode,
      issues: caseContract.issues,
    },
  });

const buildMetricContractCheck = ({ metricContract, report }) =>
  buildCheck({
    label: `${report.label} metric contract`,
    metric: "robustSuiteMetricContract",
    report,
    status: metricContract.status,
    currentValue: metricContract.metrics,
    threshold: {
      summaryMatchesRawCases: true,
    },
    detail: {
      reasonCode: metricContract.reasonCode,
      issues: metricContract.issues,
    },
  });

const buildRankingContractCheck = ({ rankingContract, report }) =>
  buildCheck({
    label: `${report.label} raw ranking contract`,
    metric: "robustSuiteRawRankingContract",
    report,
    status: rankingContract.status,
    currentValue: rankingContract.metrics,
    threshold: {
      corpusBoundExpectedUnits: true,
      corpusBoundCandidateText: true,
      immutableResultIdentity: true,
      metricsRecomputedFromRankings: true,
    },
    detail: {
      reasonCode: rankingContract.reasonCode,
      issues: rankingContract.issues,
    },
  });

const buildCorpusCaseBindingCheck = ({ corpusBinding, report }) =>
  buildCheck({
    label: `${report.label} corpus case binding`,
    metric: "robustSuiteCorpusCaseBinding",
    report,
    status: corpusBinding.status,
    currentValue: {
      corpusCaseCount: corpusBinding.corpusCaseCount,
      expectedEvaluatedCaseCount: corpusBinding.expectedEvaluatedCaseCount,
      expectedSkippedCaseCount: corpusBinding.expectedSkippedCaseCount,
    },
    threshold: {
      exactCheckedInCorpusCaseSet: true,
    },
    detail: {
      reasonCode: corpusBinding.reasonCode,
      issues: corpusBinding.issues,
    },
  });

const buildSyntheticReportResult = ({ payload, report }) => {
  const corpusBinding = validateRobustReportCorpusBinding({
    payload,
    report,
  });
  const caseContract = validateRobustReportCaseContract(payload, {
    expectedCorpusCaseCount: corpusBinding.corpusCaseCount,
  });
  const caseOutcomeContract = validateSyntheticCaseOutcomes({
    caseContracts: corpusBinding.caseContracts,
    documentContracts: corpusBinding.documentContracts,
    executionConfig: report.executionConfig,
    payload,
  });
  const metricContract = validateSyntheticMetricContract(payload, {
    caseOutcomeContract,
  });
  const caseCount = caseContract.rawCaseCount ?? 0;
  const failedCases = buildFailedCases(
    caseOutcomeContract.outcomes.map((outcome) => ({
      id: outcome.id,
      passed: outcome.passed,
    }))
  );
  const overallPassRate = metricContract.metrics.overallPassRate;
  const minOverallPassRate = report.minOverallPassRate ?? 1;
  const comparisonSemantics = validateSyntheticComparisonSemantics(payload, {
    caseOutcomeContract,
    requireComparisonCases: report.id === "compare-hard-synthetic",
  });
  const checks = [
    buildCheck({
      label: `${report.label} report exists`,
      metric: "robustSuiteReportExists",
      report,
      status: "pass",
      currentValue: `${report.latestName}.json`,
    }),
    buildCorpusCheck({
      payload,
      report,
    }),
    buildCorpusCaseBindingCheck({
      corpusBinding,
      report,
    }),
    buildCaseContractCheck({
      caseContract,
      report,
    }),
    buildMetricContractCheck({
      metricContract,
      report,
    }),
    buildCheck({
      label: `${report.label} cases`,
      metric: "robustSuiteCaseCount",
      report,
      status: caseCount > 0 ? "pass" : "fail",
      currentValue: caseCount,
      threshold: "> 0",
    }),
    buildCheck({
      label: `${report.label} failed cases`,
      metric: "robustSuiteFailedCaseCount",
      report,
      status: failedCases.length === 0 ? "pass" : "fail",
      currentValue: failedCases.length,
      threshold: 0,
    }),
    buildCheck({
      label: `${report.label} overall pass rate`,
      metric: "robustSuiteOverallPassRate",
      report,
      status:
        overallPassRate !== null && overallPassRate >= minOverallPassRate
          ? "pass"
          : "fail",
      currentValue: overallPassRate,
      threshold: minOverallPassRate,
    }),
  ];

  if (comparisonSemantics.applicable) {
    checks.push(
      buildCheck({
        label: `${report.label} comparison semantics`,
        metric: "robustSuiteComparisonSemantics",
        report,
        status: comparisonSemantics.status,
        currentValue: {
          caseCount: comparisonSemantics.comparisonCaseCount,
          hitCount: comparisonSemantics.comparisonHitCount,
          hitRate: comparisonSemantics.actualHitRate,
        },
        threshold: {
          hitRate: comparisonSemantics.expectedHitRate,
          internallyConsistent: true,
        },
        detail: {
          reasonCode: comparisonSemantics.reasonCode,
          issues: comparisonSemantics.issues,
        },
      })
    );
  }

  return {
    reportId: report.id,
    label: report.label,
    latestName: report.latestName,
    reportType: report.reportType,
    runId: payload.summary?.runId ?? null,
    status: getWorstStatus(checks.map((check) => check.status)),
    caseCount,
    failedCaseCount: failedCases.length,
    failedCases,
    checks,
  };
};

const buildRerankReportResult = ({ payload, report }) => {
  const corpusBinding = validateRobustReportCorpusBinding({
    payload,
    report,
  });
  const caseContract = validateRobustReportCaseContract(payload, {
    expectedCorpusCaseCount: corpusBinding.corpusCaseCount,
    requireSummaryCaseCount: true,
  });
  const rankingContract = validateRerankReportRankings(payload, {
    caseContracts: corpusBinding.caseContracts,
    documentContracts: corpusBinding.documentContracts,
    expectedConfig: {
      ...report.rankingConfig,
      rerankProvider: report.rerankProvider,
      rerankWeight: report.rerankWeight,
    },
  });
  const metricContract = validateRerankMetricContract(payload, {
    rankingContract,
  });
  const caseCount = caseContract.rawCaseCount ?? 0;
  const baselineNdcg = metricContract.metrics.baseline?.ndcgAtK ?? null;
  const rerankedNdcg = metricContract.metrics.reranked?.ndcgAtK ?? null;
  const baselineRecall = metricContract.metrics.baseline?.recallAtK ?? null;
  const rerankedRecall = metricContract.metrics.reranked?.recallAtK ?? null;
  const metricsAvailable =
    baselineNdcg !== null &&
    rerankedNdcg !== null &&
    baselineRecall !== null &&
    rerankedRecall !== null;
  const checks = [
    buildCheck({
      label: `${report.label} report exists`,
      metric: "robustSuiteReportExists",
      report,
      status: "pass",
      currentValue: `${report.latestName}.json`,
    }),
    buildCorpusCheck({
      payload,
      report,
    }),
    buildCorpusCaseBindingCheck({
      corpusBinding,
      report,
    }),
    buildCaseContractCheck({
      caseContract,
      report,
    }),
    buildRankingContractCheck({
      rankingContract,
      report,
    }),
    buildMetricContractCheck({
      metricContract,
      report,
    }),
    buildCheck({
      label: `${report.label} ranking cases`,
      metric: "robustSuiteCaseCount",
      report,
      status: caseCount > 0 ? "pass" : "fail",
      currentValue: caseCount,
      threshold: "> 0",
    }),
    buildCheck({
      label: `${report.label} metrics available`,
      metric: "robustSuiteRerankMetricsAvailable",
      report,
      status: metricsAvailable ? "pass" : "fail",
      detail: metricsAvailable
        ? null
        : "Expected baseline and reranked NDCG/Recall metrics.",
    }),
  ];

  if (metricsAvailable) {
    checks.push(
      buildCheck({
        label: `${report.label} NDCG regression`,
        metric: "robustSuiteRerankNdcgRegression",
        report,
        status: rerankedNdcg + epsilon >= baselineNdcg ? "pass" : "fail",
        currentValue: Number((rerankedNdcg - baselineNdcg).toFixed(4)),
        threshold: ">= 0",
      }),
      buildCheck({
        label: `${report.label} Recall regression`,
        metric: "robustSuiteRerankRecallRegression",
        report,
        status: rerankedRecall + epsilon >= baselineRecall ? "pass" : "fail",
        currentValue: Number((rerankedRecall - baselineRecall).toFixed(4)),
        threshold: ">= 0",
      }),
      buildCheck({
        label: `${report.label} NDCG lift`,
        metric: "robustSuiteRerankNdcgLift",
        report,
        status: rerankedNdcg > baselineNdcg + epsilon ? "pass" : "warn",
        currentValue: Number((rerankedNdcg - baselineNdcg).toFixed(4)),
        threshold: "> 0",
      }),
      buildCheck({
        label: `${report.label} non-saturated baseline`,
        metric: "robustSuiteRerankSaturation",
        report,
        status:
          baselineNdcg >= 1 - epsilon && rerankedNdcg >= 1 - epsilon
            ? "warn"
            : "pass",
        currentValue: {
          baselineNdcg,
          rerankedNdcg,
        },
        threshold: "baseline and reranked NDCG are not both 1.0",
      })
    );
  }

  return {
    reportId: report.id,
    label: report.label,
    latestName: report.latestName,
    reportType: report.reportType,
    runId: payload.summary?.runId ?? null,
    status: getWorstStatus(checks.map((check) => check.status)),
    caseCount,
    metrics: metricContract.metrics,
    checks,
  };
};

const buildReportResult = ({ payload, report, required }) => {
  if (!payload) {
    return buildAvailabilityFailure({
      report,
      required,
    });
  }

  if (report.reportType === "synthetic") {
    return buildSyntheticReportResult({
      payload,
      report,
    });
  }

  if (report.reportType === "rerank") {
    return buildRerankReportResult({
      payload,
      report,
    });
  }

  throw new Error(`Unsupported robust report type: ${report.reportType}`);
};

export const buildRobustSuiteGate = ({
  latestRobustPayloads = [],
  requireRobustSuite = false,
} = {}) => {
  if (!requireRobustSuite) {
    return {
      status: "pass",
      skipped: true,
      required: false,
      reports: [],
      failedReports: [],
      warningReports: [],
      checks: [],
      summary: "Robust eval suite is not required for this run.",
    };
  }

  const payloadsByReportId = normalizePayloadEntries(latestRobustPayloads);
  const reports = robustEvalSuite.reports.map((report) =>
    buildReportResult({
      payload: payloadsByReportId.get(report.id) ?? null,
      report,
      required: true,
    })
  );
  const checks = reports.flatMap((report) => report.checks);
  const failedReports = reports.filter((report) => report.status === "fail");
  const warningReports = reports.filter((report) => report.status === "warn");
  const status = getWorstStatus(reports.map((report) => report.status));
  const summary =
    status === "fail"
      ? `Robust eval suite failed ${failedReports.length} of ${reports.length} reports.`
      : status === "warn"
        ? `Robust eval suite has ${warningReports.length} warning report${warningReports.length === 1 ? "" : "s"}.`
        : `Robust eval suite passed ${reports.length} reports: ${reports
            .map((report) => report.label)
            .join(", ")}.`;

  return {
    status,
    skipped: false,
    required: true,
    reports,
    failedReports,
    warningReports,
    checks,
    summary,
  };
};

export const buildRobustSuiteGateChecks = ({ robustSuiteGate = {} } = {}) =>
  robustSuiteGate.skipped ? [] : robustSuiteGate.checks ?? [];
