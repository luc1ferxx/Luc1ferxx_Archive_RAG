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
  const cases = Array.isArray(latestTrajectoryPayload.cases)
    ? latestTrajectoryPayload.cases
    : [];
  const failedCases = cases
    .filter((caseResult) => !caseResult.passed)
    .map((caseResult) => ({
      id: caseResult.id,
      label: caseResult.label,
      failedCheckCount: caseResult.failedCheckCount ?? 0,
      failedChecks: (caseResult.checks ?? [])
        .filter((check) => !check.passed)
        .map((check) => ({
          id: check.id,
          label: check.label,
          category: check.category,
          detail: check.detail ?? null,
        })),
    }));
  const failedCaseCount = metrics.failedCaseCount ?? failedCases.length;
  const caseCount = metrics.caseCount ?? cases.length;
  const status = failedCaseCount > 0 || summary.status === "fail" ? "fail" : "pass";

  return {
    status,
    skipped: false,
    currentRunId: summary.runId ?? null,
    failedCaseCount,
    caseCount,
    failedCases,
    summary:
      status === "fail"
        ? `Trajectory evaluation failed ${failedCaseCount} of ${caseCount} case${
            caseCount === 1 ? "" : "s"
          }.`
        : `Trajectory evaluation passed all ${caseCount} case${
            caseCount === 1 ? "" : "s"
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
