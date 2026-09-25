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

const buildSkillGraphSignalCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "skill_graph",
      id: "graph_reused_nodes_not_rerun",
      label: "Settled graph nodes were reused instead of re-run",
      passed: (recovery.skillGraphReusedNodeCount ?? 0) >= 1,
      detail: `skillGraphReusedNodeCount=${recovery.skillGraphReusedNodeCount ?? 0}`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_replan_applied_recorded",
      label: "A bounded replan was recorded",
      passed: (recovery.skillGraphReplanAppliedCount ?? 0) >= 1,
      detail: `skillGraphReplanAppliedCount=${
        recovery.skillGraphReplanAppliedCount ?? 0
      }`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_fallback_after_execution_zero",
      label: "No graph fell back to the V1 chain after a node had executed",
      passed: (recovery.skillGraphUnsafeFallbackCount ?? 0) === 0,
      detail: `skillGraphUnsafeFallbackCount=${
        recovery.skillGraphUnsafeFallbackCount ?? 0
      }`,
    }),
  ],
  description:
    "A guarded skill graph should reuse settled nodes across a replan and never fall back to the V1 chain once a node has executed.",
  id: "skill_graph_signal",
  label: "Skill graph signal",
  response: {
    skillGraphExecutedCount: recovery.skillGraphExecutedCount ?? 0,
    skillGraphFallbackCount: recovery.skillGraphFallbackCount ?? 0,
    skillGraphPlannedCount: recovery.skillGraphPlannedCount ?? 0,
    skillGraphReplanAppliedCount: recovery.skillGraphReplanAppliedCount ?? 0,
    skillGraphReusedNodeCount: recovery.skillGraphReusedNodeCount ?? 0,
    skillGraphUnsafeFallbackCount: recovery.skillGraphUnsafeFallbackCount ?? 0,
  },
});

const buildSkillGraphStartupResumeCase = (recovery = {}) => ({
  checks: [
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_resume_production_observed",
      label: "A restarted graph run was observed through the production path",
      passed: recovery.skillGraphStartupResumeObservedCount === 1,
      detail: `skillGraphStartupResumeObservedCount=${
        recovery.skillGraphStartupResumeObservedCount ?? 0
      }`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_resume_claim_once",
      label: "The stored graph resume was claimed exactly once",
      passed: recovery.skillGraphResumeClaimCount === 1,
      detail: `skillGraphResumeClaimCount=${recovery.skillGraphResumeClaimCount ?? 0}`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_auto_recovery_completed",
      label: "Graph-only startup auto recovery completed without failure",
      passed:
        recovery.skillGraphAutoRecoveryCompletedCount === 1 &&
        recovery.skillGraphAutoRecoveryFailureCount === 0,
      detail: `completed=${
        recovery.skillGraphAutoRecoveryCompletedCount ?? 0
      }, failed=${recovery.skillGraphAutoRecoveryFailureCount ?? 0}`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_same_run_completed",
      label: "The interrupted run itself completed",
      passed: recovery.skillGraphSameRunCompletedCount === 1,
      detail: `skillGraphSameRunCompletedCount=${
        recovery.skillGraphSameRunCompletedCount ?? 0
      }`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_completed_node_not_rerun",
      label: "The completed node was not re-executed",
      passed: recovery.skillGraphCompletedNodeNotRerunCount === 1,
      detail: `skillGraphCompletedNodeNotRerunCount=${
        recovery.skillGraphCompletedNodeNotRerunCount ?? 0
      }`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_pending_node_once",
      label: "The pending dependent node executed exactly once",
      passed: recovery.skillGraphPendingNodeExecutedOnceCount === 1,
      detail: `skillGraphPendingNodeExecutedOnceCount=${
        recovery.skillGraphPendingNodeExecutedOnceCount ?? 0
      }`,
    }),
    buildCheck({
      category: "skill_graph",
      id: "graph_startup_no_second_claim_or_partial_fallback",
      label: "A second startup made no claim and no partial fallback occurred",
      passed:
        recovery.skillGraphSecondClaimCount === 0 &&
        recovery.skillGraphPartialResumeFallbackCount === 0 &&
        recovery.skillGraphUnsafeFallbackCount === 0,
      detail: `secondClaims=${recovery.skillGraphSecondClaimCount ?? 0}, partialFallbacks=${
        recovery.skillGraphPartialResumeFallbackCount ?? 0
      }, unsafeFallbacks=${recovery.skillGraphUnsafeFallbackCount ?? 0}`,
    }),
  ],
  description:
    "A durable partial guarded graph must resume after a simulated process restart without replaying settled work or entering the V1 fallback path.",
  id: "skill_graph_startup_resume",
  label: "Skill graph startup resume",
  response: {
    skillGraphAutoRecoveryCompletedCount:
      recovery.skillGraphAutoRecoveryCompletedCount ?? 0,
    skillGraphAutoRecoveryFailureCount:
      recovery.skillGraphAutoRecoveryFailureCount ?? 0,
    skillGraphCompletedNodeNotRerunCount:
      recovery.skillGraphCompletedNodeNotRerunCount ?? 0,
    skillGraphPartialResumeFallbackCount:
      recovery.skillGraphPartialResumeFallbackCount ?? 0,
    skillGraphPendingNodeExecutedOnceCount:
      recovery.skillGraphPendingNodeExecutedOnceCount ?? 0,
    skillGraphResumeClaimCount: recovery.skillGraphResumeClaimCount ?? 0,
    skillGraphSameRunCompletedCount:
      recovery.skillGraphSameRunCompletedCount ?? 0,
    skillGraphSecondClaimCount: recovery.skillGraphSecondClaimCount ?? 0,
    skillGraphStartupResumeObservedCount:
      recovery.skillGraphStartupResumeObservedCount ?? 0,
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
    buildSkillGraphSignalCase(recovery),
    buildSkillGraphStartupResumeCase(recovery),
  ].map(finishRecoveryCase);
