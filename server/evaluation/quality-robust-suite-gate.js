import { robustEvalSuite } from "./eval-suite.js";
import { buildFailedCases } from "./quality-run-summary.js";
import {
  getCorpusName,
  getWorstStatus,
  toNonNegativeInteger,
} from "./quality-shared.js";

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

const toFiniteNumber = (value) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
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

const getCaseCount = (payload = {}) =>
  toNonNegativeInteger(
    payload.summary?.caseCount,
    Array.isArray(payload.cases)
      ? payload.cases.length
      : toNonNegativeInteger(payload.summary?.corpus?.cases)
  );

const buildSyntheticReportResult = ({ payload, report }) => {
  const caseCount = getCaseCount(payload);
  const failedCases = buildFailedCases(payload.cases ?? []);
  const overallPassRate = toFiniteNumber(payload.summary?.metrics?.overallPassRate);
  const minOverallPassRate = report.minOverallPassRate ?? 1;
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

const getRerankMetric = ({ payload, group, metric }) =>
  toFiniteNumber(payload.summary?.metrics?.[group]?.[metric]);

const buildRerankReportResult = ({ payload, report }) => {
  const caseCount = getCaseCount(payload);
  const baselineNdcg = getRerankMetric({
    payload,
    group: "baseline",
    metric: "ndcgAtK",
  });
  const rerankedNdcg = getRerankMetric({
    payload,
    group: "reranked",
    metric: "ndcgAtK",
  });
  const baselineRecall = getRerankMetric({
    payload,
    group: "baseline",
    metric: "recallAtK",
  });
  const rerankedRecall = getRerankMetric({
    payload,
    group: "reranked",
    metric: "recallAtK",
  });
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
    metrics: payload.summary?.metrics ?? null,
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
