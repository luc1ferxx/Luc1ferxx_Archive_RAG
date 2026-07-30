import { summarizeQualityCaseResults } from "./quality-case-results.js";

export const buildTrajectoryGate = ({ latestTrajectoryPayload = null } = {}) => {
  if (!latestTrajectoryPayload) {
    return {
      status: "pass",
      skipped: true,
      currentRunId: null,
      failedCaseCount: 0,
      caseCount: 0,
      failedCases: [],
      summary:
        "No trajectory evaluation report is available; trajectory gate skipped.",
    };
  }

  const summary = latestTrajectoryPayload.summary ?? {};
  const metrics = summary.metrics ?? {};
  const caseSummary = summarizeQualityCaseResults({
    cases: latestTrajectoryPayload.cases,
    metrics,
  });
  const status =
    caseSummary.failedCaseCount > 0 ||
    caseSummary.failedCheckCount > 0 ||
    summary.status === "fail"
      ? "fail"
      : "pass";

  return {
    status,
    skipped: false,
    currentRunId: summary.runId ?? null,
    failedCaseCount: caseSummary.failedCaseCount,
    failedCheckCount: caseSummary.failedCheckCount,
    caseCount: caseSummary.caseCount,
    checkCount: caseSummary.checkCount,
    failedCases: caseSummary.failedCases,
    summary:
      status === "fail"
        ? `Trajectory evaluation failed ${caseSummary.failedCaseCount} of ${caseSummary.caseCount} case${
            caseSummary.caseCount === 1 ? "" : "s"
          }.`
        : `Trajectory evaluation passed all ${caseSummary.caseCount} case${
            caseSummary.caseCount === 1 ? "" : "s"
          }.`,
  };
};

export const buildTrajectoryGateChecks = ({ trajectoryGate = {} } = {}) =>
  trajectoryGate.skipped
    ? []
    : [
        {
          metric: "trajectoryFailedCaseCount",
          label: "Trajectory failed cases",
          status: (trajectoryGate.failedCaseCount ?? 0) > 0 ? "fail" : "pass",
          currentValue: trajectoryGate.failedCaseCount ?? 0,
          baselineValue: 0,
          delta: trajectoryGate.failedCaseCount ?? 0,
        },
      ];
