const toNonNegativeNumber = (value, fallbackValue = 0) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
};

const toArray = (value) => (Array.isArray(value) ? value : []);

const getRecoveryStats = (payload = {}) =>
  payload?.recovery ?? payload?.observability?.recovery ?? payload?.report?.recovery ?? {};

const buildMinCheck = ({ currentValue, label, metric, minimum }) => ({
  metric,
  label,
  status: currentValue >= minimum ? "pass" : "fail",
  currentValue,
  baselineValue: minimum,
  delta: currentValue - minimum,
});

const buildMaxCheck = ({ currentValue, label, metric, maximum }) => ({
  metric,
  label,
  status: currentValue <= maximum ? "pass" : "fail",
  currentValue,
  baselineValue: maximum,
  delta: currentValue - maximum,
});

const buildFailedCases = (cases = []) =>
  toArray(cases)
    .filter((caseResult) => !caseResult.passed)
    .map((caseResult) => ({
      id: caseResult.id,
      label: caseResult.label,
      failedCheckCount: caseResult.failedCheckCount ?? 0,
      failedChecks: toArray(caseResult.checks)
        .filter((check) => !check.passed)
        .map((check) => ({
          id: check.id,
          label: check.label,
          category: check.category,
          detail: check.detail ?? null,
        })),
    }));

const sumFailedChecks = (failedCases = []) =>
  failedCases.reduce(
    (sum, caseResult) =>
      sum + (caseResult.failedChecks?.length ?? caseResult.failedCheckCount ?? 0),
    0
  );

const getMetrics = ({ failedCases, payload = {} }) => {
  const summaryMetrics = payload.summary?.metrics ?? {};
  const cases = toArray(payload.cases);
  const summaryFailed = payload.summary?.status === "fail";
  const failedCaseCount = Math.max(
    toNonNegativeNumber(summaryMetrics.failedCaseCount, failedCases.length),
    summaryFailed ? 1 : 0
  );

  return {
    caseCount: toNonNegativeNumber(summaryMetrics.caseCount, cases.length),
    checkCount: toNonNegativeNumber(
      summaryMetrics.checkCount,
      cases.reduce((sum, caseResult) => sum + toArray(caseResult.checks).length, 0)
    ),
    failedCaseCount,
    failedCheckCount: Math.max(
      toNonNegativeNumber(summaryMetrics.failedCheckCount, sumFailedChecks(failedCases)),
      summaryFailed && failedCaseCount === 0 ? 1 : 0
    ),
  };
};

const buildMetricChecks = ({
  metrics = {},
  recovery = {},
  thresholds = {},
} = {}) => {
  const minRecoverableRunCount = thresholds.minRecoverableRunCount ?? 1;
  const minManualRecoveryCount = thresholds.minManualRecoveryCount ?? 1;
  const minManualRecoveryActionCount =
    thresholds.minManualRecoveryActionCount ?? 1;
  const maxManualRecoveryActionFailureCount =
    thresholds.maxManualRecoveryActionFailureCount ?? 0;
  const minAutoReplayAttemptCount = thresholds.minAutoReplayAttemptCount ?? 1;
  const minAutoReplaySuccessRate = thresholds.minAutoReplaySuccessRate ?? 1;
  const maxAutoReplayFailureCount = thresholds.maxAutoReplayFailureCount ?? 0;
  const minStepRetryCount = thresholds.minStepRetryCount ?? 1;
  const minStepResumeCount = thresholds.minStepResumeCount ?? 1;
  const maxStepReplayFailureCount = thresholds.maxStepReplayFailureCount ?? 0;
  const maxPlannerFallbackCount = thresholds.maxPlannerFallbackCount ?? 0;

  return [
    buildMaxCheck({
      currentValue: metrics.failedCaseCount ?? 0,
      label: "Recovery observability failed cases",
      maximum: 0,
      metric: "recoveryObservabilityFailedCaseCount",
    }),
    buildMaxCheck({
      currentValue: metrics.failedCheckCount ?? 0,
      label: "Recovery observability failed checks",
      maximum: 0,
      metric: "recoveryObservabilityFailedCheckCount",
    }),
    buildMinCheck({
      currentValue: recovery.recoverableRunCount ?? 0,
      label: "Recoverable runs observed",
      minimum: minRecoverableRunCount,
      metric: "recoveryRecoverableRunCount",
    }),
    buildMinCheck({
      currentValue: recovery.manualRecoveryCount ?? 0,
      label: "Manual recovery marked",
      minimum: minManualRecoveryCount,
      metric: "recoveryManualRecoveryCount",
    }),
    buildMinCheck({
      currentValue: recovery.manualRecoveryActionCount ?? 0,
      label: "Manual recovery actions observed",
      minimum: minManualRecoveryActionCount,
      metric: "recoveryManualRecoveryActionCount",
    }),
    buildMaxCheck({
      currentValue: recovery.manualRecoveryActionFailureCount ?? 0,
      label: "Manual recovery action failures",
      maximum: maxManualRecoveryActionFailureCount,
      metric: "recoveryManualRecoveryActionFailureCount",
    }),
    buildMinCheck({
      currentValue: recovery.autoReplayAttemptCount ?? 0,
      label: "Auto replay attempts observed",
      minimum: minAutoReplayAttemptCount,
      metric: "recoveryAutoReplayAttemptCount",
    }),
    buildMinCheck({
      currentValue: recovery.autoReplaySuccessRate ?? 0,
      label: "Auto replay success rate",
      minimum: minAutoReplaySuccessRate,
      metric: "recoveryAutoReplaySuccessRate",
    }),
    buildMaxCheck({
      currentValue: recovery.autoReplayFailureCount ?? 0,
      label: "Auto replay failures",
      maximum: maxAutoReplayFailureCount,
      metric: "recoveryAutoReplayFailureCount",
    }),
    buildMinCheck({
      currentValue: recovery.stepRetryCount ?? 0,
      label: "Step retry replays observed",
      minimum: minStepRetryCount,
      metric: "recoveryStepRetryCount",
    }),
    buildMinCheck({
      currentValue: recovery.stepResumeCount ?? 0,
      label: "Step resume replays observed",
      minimum: minStepResumeCount,
      metric: "recoveryStepResumeCount",
    }),
    buildMaxCheck({
      currentValue: recovery.stepReplayFailureCount ?? 0,
      label: "Step replay failures",
      maximum: maxStepReplayFailureCount,
      metric: "recoveryStepReplayFailureCount",
    }),
    buildMaxCheck({
      currentValue: recovery.plannerFallbackCount ?? 0,
      label: "Observed planner fallbacks",
      maximum: maxPlannerFallbackCount,
      metric: "recoveryPlannerFallbackCount",
    }),
  ];
};

export const buildRecoveryGate = ({
  latestRecoveryPayload = null,
  thresholds = {},
} = {}) => {
  if (!latestRecoveryPayload) {
    return {
      status: "pass",
      skipped: true,
      currentRunId: null,
      caseCount: 0,
      checkCount: 0,
      failedCaseCount: 0,
      failedCheckCount: 0,
      failedCases: [],
      recovery: {},
      checks: [],
      summary:
        "No recovery observability evaluation report is available; recovery gate skipped.",
    };
  }

  const recovery = getRecoveryStats(latestRecoveryPayload);
  const failedCases = buildFailedCases(latestRecoveryPayload.cases);
  const metrics = getMetrics({
    failedCases,
    payload: latestRecoveryPayload,
  });
  const checks = buildMetricChecks({
    metrics,
    recovery,
    thresholds,
  });
  const failedChecks = checks.filter((check) => check.status === "fail");
  const status = failedChecks.length > 0 ? "fail" : "pass";

  return {
    status,
    skipped: false,
    currentRunId: latestRecoveryPayload.summary?.runId ?? null,
    caseCount: metrics.caseCount,
    checkCount: metrics.checkCount,
    failedCaseCount: metrics.failedCaseCount,
    failedCheckCount: metrics.failedCheckCount,
    failedCases,
    failedChecks,
    recovery,
    checks,
    summary:
      status === "fail"
        ? `Recovery observability failed ${failedChecks.length} gate check${
            failedChecks.length === 1 ? "" : "s"
          }; replay failures ${recovery.stepReplayFailureCount ?? 0}, manual action failures ${
            recovery.manualRecoveryActionFailureCount ?? 0
          }, auto replay success rate ${recovery.autoReplaySuccessRate ?? 0}.`
        : `Recovery observability passed ${metrics.caseCount} case${
            metrics.caseCount === 1 ? "" : "s"
          }; replay failures ${recovery.stepReplayFailureCount ?? 0}, manual action failures ${
            recovery.manualRecoveryActionFailureCount ?? 0
          }, auto replay success rate ${recovery.autoReplaySuccessRate ?? 0}.`,
  };
};

export const buildRecoveryGateChecks = ({ recoveryGate = {} } = {}) =>
  recoveryGate.skipped ? [] : recoveryGate.checks ?? [];
