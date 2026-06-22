import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCaseCheckTable,
  appendCategoryMetricsTable,
  buildCheck,
  buildMetricSummary,
} from "./agent-eval-harness.js";
import { buildObservabilityReport } from "./observability-report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");

const LATEST_RECOVERY_OBSERVABILITY_JSON = "latest-recovery-observability.json";
const LATEST_RECOVERY_OBSERVABILITY_MD = "latest-recovery-observability.md";

export const RECOVERY_OBSERVABILITY_CATEGORY_LABELS = {
  coverage: "Coverage",
  manual_recovery: "Manual recovery",
  primary_lifecycle: "Primary lifecycle",
  replay: "Replay",
  planner: "Planner",
};

const toIsoDate = (date = new Date()) =>
  date instanceof Date ? date.toISOString() : new Date(date).toISOString();

const toRunId = (createdAt) =>
  `recovery-observability-${createdAt.replace(/[:.]/g, "-")}`;

export const buildRecoveryObservabilityFixtureEvents = () => [
  {
    traceType: "agent_run_recovery",
    eventType: "startup_recovery_completed",
    recoverableRunCount: 3,
    manualRecoveryCount: 1,
    autoReplayAttemptCount: 2,
    autoReplaySuccessCount: 2,
    autoReplayFailureCount: 0,
  },
  {
    type: "step_started",
    payload: {
      status: "running",
      stepId: "document_rag:primary",
    },
  },
  {
    type: "step_completed",
    payload: {
      status: "completed",
      stepId: "document_rag:primary",
    },
  },
  {
    type: "step_started",
    payload: {
      status: "running",
      stepId: "document_rag:primary",
    },
  },
  {
    type: "step_failed",
    payload: {
      status: "failed",
      stepId: "document_rag:primary",
    },
  },
  {
    traceType: "agent_run_recovery",
    eventType: "manual_recovery_action",
    action: "resume_from_step",
    status: "completed",
  },
  {
    traceType: "agent_run_recovery",
    eventType: "manual_recovery_action",
    action: "retry_failed_step",
    status: "completed",
  },
  {
    traceType: "agent_run_recovery",
    eventType: "manual_recovery_action",
    action: "cancel",
    status: "completed",
  },
  {
    traceType: "agent_run_step_replay",
    action: "resume_step",
    status: "completed",
  },
  {
    traceType: "agent_run_step_replay",
    action: "retry_step",
    status: "completed",
  },
  {
    traceType: "agent",
    agentMode: "document",
    agentObservability: {
      executionPlanner: {
        fallback: false,
        requestedPlannerId: "deterministic",
        selectedPlannerId: "deterministic",
        status: "selected",
        stepIds: ["document_rag"],
      },
    },
  },
];

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
    buildPlannerFallbackCase(recovery),
  ].map(finishRecoveryCase);

export const buildRecoveryObservabilityEvaluationReport = ({
  createdAt = toIsoDate(),
  events = buildRecoveryObservabilityFixtureEvents(),
  runId = null,
} = {}) => {
  const observability = buildObservabilityReport({
    events,
  });
  const cases = buildRecoveryObservabilityCases({
    recovery: observability.recovery,
  });
  const metrics = buildMetricSummary({
    caseResults: cases,
    categoryLabels: RECOVERY_OBSERVABILITY_CATEGORY_LABELS,
  });
  const status =
    metrics.failedCaseCount > 0 || metrics.failedCheckCount > 0 ? "fail" : "pass";

  return {
    summary: {
      runId: runId ?? toRunId(createdAt),
      createdAt,
      status,
      version: "1.0.0",
      metrics,
    },
    recovery: observability.recovery,
    observability,
    cases,
  };
};

export const formatRecoveryObservabilityReportMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const metrics = summary.metrics ?? {};
  const recovery = report.recovery ?? {};
  const lines = [
    "# AgentRAG Recovery Observability Eval",
    "",
    `- Run ID: \`${summary.runId ?? "unknown"}\``,
    `- Created: \`${summary.createdAt ?? "unknown"}\``,
    `- Status: \`${summary.status ?? "unknown"}\``,
    `- Cases: \`${metrics.passedCaseCount ?? 0}/${metrics.caseCount ?? 0}\` passed`,
    `- Checks: \`${metrics.passedCheckCount ?? 0}/${metrics.checkCount ?? 0}\` passed`,
    "",
    "## Recovery Metrics",
    "",
    `- Recoverable runs: \`${recovery.recoverableRunCount ?? 0}\``,
    `- Manual recovery marked: \`${recovery.manualRecoveryCount ?? 0}\``,
    `- Manual recovery actions: \`${recovery.manualRecoveryActionCount ?? 0}\``,
    `- Manual recovery action failures: \`${
      recovery.manualRecoveryActionFailureCount ?? 0
    }\``,
    `- Auto replay attempts: \`${recovery.autoReplayAttemptCount ?? 0}\``,
    `- Auto replay success rate: \`${recovery.autoReplaySuccessRate ?? 0}\``,
    `- Auto replay failures: \`${recovery.autoReplayFailureCount ?? 0}\``,
    `- Step lifecycle events: \`${recovery.stepLifecycleEventCount ?? 0}\``,
    `- Primary step started: \`${recovery.primaryStepStartedCount ?? 0}\``,
    `- Primary step completed: \`${recovery.primaryStepCompletedCount ?? 0}\``,
    `- Primary step failed: \`${recovery.primaryStepFailedCount ?? 0}\``,
    `- Step retry count: \`${recovery.stepRetryCount ?? 0}\``,
    `- Step resume count: \`${recovery.stepResumeCount ?? 0}\``,
    `- Step replay failures: \`${recovery.stepReplayFailureCount ?? 0}\``,
    `- Planner fallback count: \`${recovery.plannerFallbackCount ?? 0}\``,
  ];

  appendCategoryMetricsTable({
    categories: metrics.categories ?? {},
    lines,
  });

  lines.push("", "## Cases", "");

  for (const caseResult of report.cases ?? []) {
    lines.push(
      `### ${caseResult.passed ? "PASS" : "FAIL"} ${caseResult.label}`,
      "",
      caseResult.description,
      "",
      `- ID: \`${caseResult.id}\``
    );

    appendCaseCheckTable({
      categoryLabels: RECOVERY_OBSERVABILITY_CATEGORY_LABELS,
      checks: caseResult.checks,
      lines,
    });

    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
};

export const writeRecoveryObservabilityEvaluationReport = async ({
  outputDirectory = resultsDirectory,
  report,
} = {}) => {
  await mkdir(outputDirectory, {
    recursive: true,
  });

  const jsonPath = path.join(outputDirectory, LATEST_RECOVERY_OBSERVABILITY_JSON);
  const markdownPath = path.join(outputDirectory, LATEST_RECOVERY_OBSERVABILITY_MD);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    formatRecoveryObservabilityReportMarkdown(report),
    "utf8"
  );

  return {
    jsonPath,
    markdownPath,
  };
};
