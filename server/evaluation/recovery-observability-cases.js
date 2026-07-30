import { buildCheck } from "./agent-eval-harness.js";

const buildStartupCoverageCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "coverage",
      id: "recoverable_runs_recorded",
      label: "Recoverable runs were recorded",
      passed: (recovery.recoverableRunCount ?? 0) >= 1,
      detail: `recoverableRunCount=${recovery.recoverableRunCount ?? 0}`,
    }),
    buildCheck({
      category: "coverage",
      id: "manual_recovery_required",
      label: "Manual recovery requirement was recorded",
      passed: (recovery.manualRecoveryCount ?? 0) >= 1,
      detail: `manualRecoveryCount=${recovery.manualRecoveryCount ?? 0}`,
    }),
    buildCheck({
      category: "replay",
      id: "auto_recovery_attempted",
      label: "Auto recovery attempt was recorded",
      passed: (recovery.autoReplayAttemptCount ?? 0) >= 1,
      detail: `autoReplayAttemptCount=${recovery.autoReplayAttemptCount ?? 0}`,
    }),
    buildCheck({
      category: "replay",
      id: "auto_replay_success_rate_clean",
      label: "Auto replay success rate is clean",
      passed:
        (recovery.autoReplayAttemptCount ?? 0) > 0 &&
        recovery.autoReplaySuccessRate === 1,
      detail: `autoReplaySuccessRate=${recovery.autoReplaySuccessRate ?? 0}`,
    }),
    buildCheck({
      category: "replay",
      id: "auto_replay_failures_zero",
      label: "Auto replay failures stayed at zero",
      passed: (recovery.autoReplayFailureCount ?? 0) === 0,
      detail: `autoReplayFailureCount=${recovery.autoReplayFailureCount ?? 0}`,
    }),
  ],
  description:
    "A startup recovery summary should expose manual recovery and safe auto replay coverage.",
  id: "startup_recovery_summary",
  label: "Startup recovery summary",
  response: {
    autoReplayAttemptCount: recovery.autoReplayAttemptCount ?? 0,
    autoReplaySuccessRate: recovery.autoReplaySuccessRate ?? 0,
    manualRecoveryCount: recovery.manualRecoveryCount ?? 0,
    recoverableRunCount: recovery.recoverableRunCount ?? 0,
  },
});

const buildPrimaryStepLifecycleCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "primary_lifecycle",
      id: "primary_step_started",
      label: "Primary persisted step start was recorded",
      passed: (recovery.primaryStepStartedCount ?? 0) >= 1,
      detail: `primaryStepStartedCount=${
        recovery.primaryStepStartedCount ?? 0
      }`,
    }),
    buildCheck({
      category: "primary_lifecycle",
      id: "primary_step_completed",
      label: "Primary persisted step completion was recorded",
      passed: (recovery.primaryStepCompletedCount ?? 0) >= 1,
      detail: `primaryStepCompletedCount=${
        recovery.primaryStepCompletedCount ?? 0
      }`,
    }),
    buildCheck({
      category: "primary_lifecycle",
      id: "primary_step_failed",
      label: "Primary persisted step failure was recorded",
      passed: (recovery.primaryStepFailedCount ?? 0) >= 1,
      detail: `primaryStepFailedCount=${recovery.primaryStepFailedCount ?? 0}`,
    }),
  ],
  description:
    "Persisted primary agent run steps should expose start, completion, and failure lifecycle events to recovery reporting.",
  id: "primary_step_lifecycle",
  label: "Primary persisted step lifecycle",
  response: {
    primaryStepCompletedCount: recovery.primaryStepCompletedCount ?? 0,
    primaryStepFailedCount: recovery.primaryStepFailedCount ?? 0,
    primaryStepStartedCount: recovery.primaryStepStartedCount ?? 0,
    primaryStepLifecycleCounts: recovery.primaryStepLifecycleCounts ?? {},
  },
});

const buildManualRecoveryCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "manual_recovery",
      id: "manual_actions_recorded",
      label: "Manual recovery actions were recorded",
      passed: (recovery.manualRecoveryActionCount ?? 0) >= 1,
      detail: `manualRecoveryActionCount=${
        recovery.manualRecoveryActionCount ?? 0
      }`,
    }),
    buildCheck({
      category: "manual_recovery",
      id: "resume_after_partial_step_recorded",
      label: "Resume after partial step was recorded",
      passed: (recovery.actionCounts?.resume_from_step ?? 0) >= 1,
      detail: `resume_from_step=${recovery.actionCounts?.resume_from_step ?? 0}`,
    }),
    buildCheck({
      category: "manual_recovery",
      id: "retry_after_failed_step_recorded",
      label: "Retry after failed step was recorded",
      passed: (recovery.actionCounts?.retry_failed_step ?? 0) >= 1,
      detail: `retry_failed_step=${recovery.actionCounts?.retry_failed_step ?? 0}`,
    }),
    buildCheck({
      category: "manual_recovery",
      id: "cancel_action_recorded",
      label: "Cancel action was recorded",
      passed: (recovery.actionCounts?.cancel ?? 0) >= 1,
      detail: `cancel=${recovery.actionCounts?.cancel ?? 0}`,
    }),
    buildCheck({
      category: "manual_recovery",
      id: "manual_action_failures_zero",
      label: "Manual recovery action failures stayed at zero",
      passed: (recovery.manualRecoveryActionFailureCount ?? 0) === 0,
      detail: `manualRecoveryActionFailureCount=${
        recovery.manualRecoveryActionFailureCount ?? 0
      }`,
    }),
  ],
  description:
    "Manual recovery operations should be visible without adding a second counter path.",
  id: "manual_recovery_actions",
  label: "Manual recovery actions",
  response: {
    actionCounts: recovery.actionCounts ?? {},
    manualRecoveryActionCount: recovery.manualRecoveryActionCount ?? 0,
    manualRecoveryActionFailureCount:
      recovery.manualRecoveryActionFailureCount ?? 0,
  },
});

const buildStepReplayCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "replay",
      id: "retry_step_recorded",
      label: "Retry step replay was recorded",
      passed: (recovery.stepRetryCount ?? 0) >= 1,
      detail: `stepRetryCount=${recovery.stepRetryCount ?? 0}`,
    }),
    buildCheck({
      category: "replay",
      id: "resume_step_recorded",
      label: "Resume step replay was recorded",
      passed: (recovery.stepResumeCount ?? 0) >= 1,
      detail: `stepResumeCount=${recovery.stepResumeCount ?? 0}`,
    }),
    buildCheck({
      category: "replay",
      id: "step_replay_failures_zero",
      label: "Step replay failures stayed at zero",
      passed: (recovery.stepReplayFailureCount ?? 0) === 0,
      detail: `stepReplayFailureCount=${recovery.stepReplayFailureCount ?? 0}`,
    }),
  ],
  description:
    "Step-level replay events should cover resume and retry paths with no replay failures.",
  id: "step_replay_actions",
  label: "Step replay actions",
  response: {
    stepReplayFailureCount: recovery.stepReplayFailureCount ?? 0,
    stepResumeCount: recovery.stepResumeCount ?? 0,
    stepRetryCount: recovery.stepRetryCount ?? 0,
  },
});

const buildAgentTaskRecoveryCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "task_recovery",
      id: "agent_task_recovery_recorded",
      label: "Agent task recovery was recorded",
      passed:
        (recovery.taskRecoveryScheduledCount ?? 0) >= 1 &&
        (recovery.taskRecoveryCompletedCount ?? 0) >= 1,
      detail: `scheduled=${recovery.taskRecoveryScheduledCount ?? 0}, completed=${
        recovery.taskRecoveryCompletedCount ?? 0
      }`,
    }),
    buildCheck({
      category: "task_recovery",
      id: "agent_task_resume_failures_zero",
      label: "Agent task resume failures stayed at zero",
      passed: (recovery.taskRecoveryResumeFailureCount ?? 0) === 0,
      detail: `taskRecoveryResumeFailureCount=${
        recovery.taskRecoveryResumeFailureCount ?? 0
      }`,
    }),
  ],
  description:
    "PostgreSQL-backed agent task recovery should be visible in observability without leaking task payloads.",
  id: "agent_task_recovery",
  label: "Agent task recovery",
  response: {
    taskRecoveryCompletedCount: recovery.taskRecoveryCompletedCount ?? 0,
    taskRecoveryResumeActionCount: recovery.taskRecoveryResumeActionCount ?? 0,
    taskRecoveryResumeFailureCount:
      recovery.taskRecoveryResumeFailureCount ?? 0,
    taskRecoveryScheduledCount: recovery.taskRecoveryScheduledCount ?? 0,
  },
});

const buildPlannerFallbackCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "planner",
      id: "planner_fallbacks_zero",
      label: "Observed planner fallbacks stayed at zero",
      passed: (recovery.plannerFallbackCount ?? 0) === 0,
      detail: `plannerFallbackCount=${recovery.plannerFallbackCount ?? 0}`,
    }),
  ],
  description:
    "Recovery readiness should keep runtime planner fallback signals visible to the quality gate.",
  id: "planner_fallback_signal",
  label: "Planner fallback signal",
  response: {
    plannerFallbackCount: recovery.plannerFallbackCount ?? 0,
  },
});

const finishRecoveryCase = (caseResult) => {
  const failedChecks = caseResult.checks.filter((check) => !check.passed);

  return {
    ...caseResult,
    failedCheckCount: failedChecks.length,
    passed: failedChecks.length === 0,
  };
};

export const buildRecoveryObservabilityCases = ({ recovery = {} } = {}) =>
  [
    buildStartupCoverageCase(recovery),
    buildPrimaryStepLifecycleCase(recovery),
    buildManualRecoveryCase(recovery),
    buildStepReplayCase(recovery),
    buildAgentTaskRecoveryCase(recovery),
    buildPlannerFallbackCase(recovery),
  ].map(finishRecoveryCase);
