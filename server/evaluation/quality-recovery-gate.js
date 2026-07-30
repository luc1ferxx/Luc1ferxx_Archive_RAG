import { summarizeQualityCaseResults } from "./quality-case-results.js";

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

const getMetrics = ({ payload = {} }) => {
  const summaryMetrics = payload.summary?.metrics ?? {};
  const summaryFailed = payload.summary?.status === "fail";
  const caseSummary = summarizeQualityCaseResults({
    cases: payload.cases,
    metrics: summaryMetrics,
  });

  return {
    ...caseSummary,
    failedCaseCount: Math.max(
      caseSummary.failedCaseCount,
      summaryFailed ? 1 : 0
    ),
    failedCheckCount: Math.max(
      caseSummary.failedCheckCount,
      summaryFailed && caseSummary.failedCaseCount === 0 ? 1 : 0
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
  const minPrimaryStepStartedCount =
    thresholds.minPrimaryStepStartedCount ?? 1;
  const minPrimaryStepCompletedCount =
    thresholds.minPrimaryStepCompletedCount ?? 1;
  const minPrimaryStepFailedCount = thresholds.minPrimaryStepFailedCount ?? 0;
  const minStepRetryCount = thresholds.minStepRetryCount ?? 1;
  const minStepResumeCount = thresholds.minStepResumeCount ?? 1;
  const maxStepReplayFailureCount = thresholds.maxStepReplayFailureCount ?? 0;
  const minTaskRecoveryScheduledCount =
    thresholds.minTaskRecoveryScheduledCount ?? 1;
  const minTaskRecoveryResumeActionCount =
    thresholds.minTaskRecoveryResumeActionCount ?? 1;
  const maxTaskRecoveryResumeFailureCount =
    thresholds.maxTaskRecoveryResumeFailureCount ?? 0;
  const minTaskRecoveryCompletedCount =
    thresholds.minTaskRecoveryCompletedCount ?? 1;
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
      currentValue: recovery.primaryStepStartedCount ?? 0,
      label: "Primary persisted step starts observed",
      minimum: minPrimaryStepStartedCount,
      metric: "recoveryPrimaryStepStartedCount",
    }),
    buildMinCheck({
      currentValue: recovery.primaryStepCompletedCount ?? 0,
      label: "Primary persisted step completions observed",
      minimum: minPrimaryStepCompletedCount,
      metric: "recoveryPrimaryStepCompletedCount",
    }),
    buildMinCheck({
      currentValue: recovery.primaryStepFailedCount ?? 0,
      label: "Primary persisted step failures observed",
      minimum: minPrimaryStepFailedCount,
      metric: "recoveryPrimaryStepFailedCount",
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
    buildMinCheck({
      currentValue: recovery.taskRecoveryScheduledCount ?? 0,
      label: "Agent task recovery scheduled",
      minimum: minTaskRecoveryScheduledCount,
      metric: "recoveryTaskRecoveryScheduledCount",
    }),
    buildMinCheck({
      currentValue: recovery.taskRecoveryResumeActionCount ?? 0,
      label: "Agent task resume actions observed",
      minimum: minTaskRecoveryResumeActionCount,
      metric: "recoveryTaskRecoveryResumeActionCount",
    }),
    buildMaxCheck({
      currentValue: recovery.taskRecoveryResumeFailureCount ?? 0,
      label: "Agent task resume failures",
      maximum: maxTaskRecoveryResumeFailureCount,
      metric: "recoveryTaskRecoveryResumeFailureCount",
    }),
    buildMinCheck({
      currentValue: recovery.taskRecoveryCompletedCount ?? 0,
      label: "Agent tasks completed after recovery",
      minimum: minTaskRecoveryCompletedCount,
      metric: "recoveryTaskRecoveryCompletedCount",
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
  const metrics = getMetrics({
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
    failedCases: metrics.failedCases,
    failedChecks,
    recovery,
    checks,
    summary:
      status === "fail"
        ? `Recovery observability failed ${failedChecks.length} gate check${
            failedChecks.length === 1 ? "" : "s"
          }; replay failures ${recovery.stepReplayFailureCount ?? 0}, manual action failures ${
            recovery.manualRecoveryActionFailureCount ?? 0
          }, task resume failures ${
            recovery.taskRecoveryResumeFailureCount ?? 0
          }, primary lifecycle ${recovery.primaryStepStartedCount ?? 0}/${
            recovery.primaryStepCompletedCount ?? 0
          }/${recovery.primaryStepFailedCount ?? 0}, auto replay success rate ${
            recovery.autoReplaySuccessRate ?? 0
          }.`
        : `Recovery observability passed ${metrics.caseCount} case${
            metrics.caseCount === 1 ? "" : "s"
          }; replay failures ${recovery.stepReplayFailureCount ?? 0}, manual action failures ${
            recovery.manualRecoveryActionFailureCount ?? 0
          }, task resume failures ${
            recovery.taskRecoveryResumeFailureCount ?? 0
          }, primary lifecycle ${recovery.primaryStepStartedCount ?? 0}/${
            recovery.primaryStepCompletedCount ?? 0
          }/${recovery.primaryStepFailedCount ?? 0}, auto replay success rate ${
            recovery.autoReplaySuccessRate ?? 0
          }.`,
  };
};

export const buildRecoveryGateChecks = ({ recoveryGate = {} } = {}) =>
  recoveryGate.skipped ? [] : recoveryGate.checks ?? [];
