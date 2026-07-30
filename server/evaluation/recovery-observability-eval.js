import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachEvaluationEvidence } from "./eval-evidence.js";
import {
  appendCaseCheckTable,
  appendCategoryMetricsTable,
  buildMetricSummary,
} from "./agent-eval-harness.js";
import {
  buildRecoveryObservabilityCases,
} from "./recovery-observability-cases.js";
import { buildObservabilityReport } from "./observability-report.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  createDocumentRagStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import { createJobOrchestrator, TASK_ACTIONS } from "../rag/job-orchestrator.js";
import {
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

export { buildRecoveryObservabilityCases };

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
  task_recovery: "Task recovery",
  planner: "Planner",
};

const toIsoDate = (date = new Date()) =>
  date instanceof Date ? date.toISOString() : new Date(date).toISOString();

const toRunId = (createdAt) =>
  `recovery-observability-${createdAt.replace(/[:.]/g, "-")}`;

const productionFixtureAccessScope = Object.freeze({
  userId: "recovery-eval-user",
  workspaceId: "recovery-eval-workspace",
});

const productionFixtureNow = () => "2026-06-19T00:00:00.000Z";

const createProductionFixtureRunService = () =>
  createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: productionFixtureNow,
    }),
  });

const createProductionFixtureDocumentExecutor = ({
  agentRunService,
  replayEvents,
  text = "Recovered document answer.",
} = {}) =>
  createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async () => ({
          citations: [
            {
              docId: "doc-1",
              title: "Policy",
            },
          ],
          text,
        }),
      },
    }),
    now: productionFixtureNow,
    recordStepReplayTrace: async (event) => replayEvents.push(event),
  });

const createManualRecoveryRun = async ({
  agentRunService,
  runId,
  status = AGENT_RUN_STEP_STATUSES.paused,
  stepId,
  type = "document_rag",
} = {}) => {
  await agentRunService.createRun({
    accessScope: productionFixtureAccessScope,
    goal: "Recover a persisted document step.",
    input: {
      docIds: ["doc-1"],
    },
    runId,
  });
  await agentRunService.updateRun({
    accessScope: productionFixtureAccessScope,
    runId,
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "recovery_observability_eval_fixture",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: stepId,
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          status,
          type,
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    accessScope: productionFixtureAccessScope,
    runId,
    type: "manual_recovery_required",
    payload: {
      reason: "recovery_observability_eval_fixture",
    },
  });
};

const collectRunEvents = async ({ agentRunService, runIds = [] } = {}) => {
  const events = [];

  for (const runId of runIds) {
    const run = await agentRunService.getRun({
      accessScope: productionFixtureAccessScope,
      runId,
    });

    events.push(...(run?.events ?? []));
  }

  return events;
};

const buildProductionLifecycleEvents = async () => {
  const agentRunService = createProductionFixtureRunService();

  await agentRunService.createRun({
    accessScope: productionFixtureAccessScope,
    goal: "Record a completed primary step.",
    runId: "lifecycle-completed",
  });
  const completedLifecycle = createAgentRunStepLifecycle({
    accessScope: productionFixtureAccessScope,
    agentRunService,
    runId: "lifecycle-completed",
  });
  await completedLifecycle.startStep({
    id: "document_rag:primary",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await completedLifecycle.completeStep({
    id: "document_rag:primary",
    output: {
      citationCount: 1,
      text: "Completed primary step.",
    },
  });

  await agentRunService.createRun({
    accessScope: productionFixtureAccessScope,
    goal: "Record a failed primary step.",
    runId: "lifecycle-failed",
  });
  const failedLifecycle = createAgentRunStepLifecycle({
    accessScope: productionFixtureAccessScope,
    agentRunService,
    runId: "lifecycle-failed",
  });
  await failedLifecycle.startStep({
    id: "document_rag:primary",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await failedLifecycle.failStep({
    error: new Error("Primary step failed."),
    id: "document_rag:primary",
  });

  return collectRunEvents({
    agentRunService,
    runIds: ["lifecycle-completed", "lifecycle-failed"],
  });
};

const buildProductionStartupRecoveryEvents = async () => {
  const agentRunService = createProductionFixtureRunService();
  const recoveryEvents = [];
  const replayEvents = [];
  const agentRunStepExecutor = createProductionFixtureDocumentExecutor({
    agentRunService,
    replayEvents,
  });

  for (const runId of ["auto-document-1", "auto-document-2"]) {
    await agentRunService.createRun({
      accessScope: productionFixtureAccessScope,
      goal: "Recover a safe document step.",
      input: {
        docIds: ["doc-1"],
      },
      runId,
    });
    await agentRunService.updateRun({
      accessScope: productionFixtureAccessScope,
      runId,
      patch: {
        steps: [
          {
            id: `${runId}:step`,
            input: {
              docIds: ["doc-1"],
              question: "What changed?",
            },
            status: AGENT_RUN_STEP_STATUSES.running,
            type: "document_rag",
          },
        ],
      },
    });
  }

  await agentRunService.createRun({
    accessScope: productionFixtureAccessScope,
    goal: "Recover an unsafe web step.",
    runId: "manual-web-search",
  });
  await agentRunService.updateRun({
    accessScope: productionFixtureAccessScope,
    runId: "manual-web-search",
    patch: {
      steps: [
        {
          id: "web_search:primary",
          input: {
            question: "Search the web.",
          },
          status: AGENT_RUN_STEP_STATUSES.running,
          type: "web_search",
        },
      ],
    },
  });

  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    agentRunStepExecutor,
    now: productionFixtureNow,
    recordRecoveryTrace: async (event) => recoveryEvents.push(event),
  });

  await recoveryService.recoverOnStartup({
    mode: "auto",
  });

  return [...recoveryEvents, ...replayEvents];
};

const buildProductionManualActionEvents = async () => {
  const agentRunService = createProductionFixtureRunService();
  const recoveryEvents = [];
  const replayEvents = [];
  const agentRunStepExecutor = createProductionFixtureDocumentExecutor({
    agentRunService,
    replayEvents,
  });
  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor,
    now: productionFixtureNow,
    recordRecoveryTrace: async (event) => recoveryEvents.push(event),
  });

  await createManualRecoveryRun({
    agentRunService,
    runId: "manual-resume",
    stepId: "manual-resume-step",
  });
  await createManualRecoveryRun({
    agentRunService,
    runId: "manual-cancel",
    stepId: "manual-cancel-step",
  });
  await agentRunService.createRun({
    accessScope: productionFixtureAccessScope,
    goal: "Retry a failed document step.",
    input: {
      docIds: ["doc-1"],
    },
    runId: "manual-retry",
  });
  await agentRunService.completeRun({
    accessScope: productionFixtureAccessScope,
    runId: "manual-retry",
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        error: {
          message: "Document step failed.",
        },
        id: "manual-retry-step",
        input: {
          docIds: ["doc-1"],
          question: "What changed?",
        },
        status: AGENT_RUN_STEP_STATUSES.failed,
        type: "document_rag",
      },
    ],
  });

  await actionService.applyRecoveryAction({
    accessScope: productionFixtureAccessScope,
    action: "resume_from_step",
    runId: "manual-resume",
  });
  await actionService.applyRecoveryAction({
    accessScope: productionFixtureAccessScope,
    action: "retry_failed_step",
    runId: "manual-retry",
  });
  await actionService.applyRecoveryAction({
    accessScope: productionFixtureAccessScope,
    action: "cancel",
    payload: {
      reason: "operator_cancel",
    },
    runId: "manual-cancel",
  });

  return [...recoveryEvents, ...replayEvents];
};

const buildProductionTaskRecoveryEvents = async () => {
  const scheduledWork = [];
  const taskRecoveryEvents = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore({
      now: productionFixtureNow,
    }),
  });
  const runnerId = "agent_task";

  await taskService.upsertTask({
    accessScope: productionFixtureAccessScope,
    task: {
      id: "task-recoverable",
      runnerId,
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });
  await taskService.upsertTask({
    accessScope: productionFixtureAccessScope,
    task: {
      id: "task-waiting",
      requiredUserAction: "confirm_agent_task",
      runnerId,
      status: TASK_STATUSES.waitingForUser,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async (event) => taskRecoveryEvents.push(event),
    runners: {
      [runnerId]: {
        resume: ({ action }) => {
          if (action !== TASK_ACTIONS.confirm) {
            const error = new Error("Unsupported action.");
            error.status = 400;
            throw error;
          }

          return {
            status: TASK_STATUSES.queued,
            summary: "Task queued after approval.",
          };
        },
        run: () => ({
          result: {
            completed: true,
          },
          status: TASK_STATUSES.completed,
          summary: "Task completed after recovery.",
        }),
      },
    },
    schedule: (work) => scheduledWork.push(work),
    taskService,
    now: productionFixtureNow,
  });

  await orchestrator.recoverRunnableTasks();
  await scheduledWork.shift()?.();
  await orchestrator.resumeTask({
    accessScope: productionFixtureAccessScope,
    action: TASK_ACTIONS.confirm,
    runImmediately: false,
    taskId: "task-waiting",
  });

  return taskRecoveryEvents;
};

export const buildRecoveryObservabilityProductionEvents = async () => [
  ...(await buildProductionStartupRecoveryEvents()),
  ...(await buildProductionManualActionEvents()),
  ...(await buildProductionLifecycleEvents()),
  ...(await buildProductionTaskRecoveryEvents()),
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
    traceType: "agent_task_recovery",
    eventType: "task_recovery_scheduled",
    scheduledCount: 1,
    taskRefs: [
      {
        runnerId: "agent_task",
        status: "queued",
        taskId: "task-recoverable",
      },
    ],
  },
  {
    traceType: "agent_task_recovery",
    eventType: "task_recovery_run",
    resultStatus: "completed",
    runnerId: "agent_task",
    status: "completed",
    taskId: "task-recoverable",
  },
  {
    traceType: "agent_task_recovery",
    eventType: "task_resume_action",
    action: "confirm",
    resultStatus: "queued",
    runnerId: "agent_task",
    status: "completed",
    taskId: "task-waiting",
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
    `- Task recovery scheduled: \`${recovery.taskRecoveryScheduledCount ?? 0}\``,
    `- Task recovery resume actions: \`${
      recovery.taskRecoveryResumeActionCount ?? 0
    }\``,
    `- Task recovery resume failures: \`${
      recovery.taskRecoveryResumeFailureCount ?? 0
    }\``,
    `- Task recovery completed: \`${recovery.taskRecoveryCompletedCount ?? 0}\``,
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
  const writtenReport = report?.evidence
    ? report
    : await attachEvaluationEvidence(report, {
        command: "npm run eval:recovery-observability",
        profile: process.env.EVAL_EVIDENCE_PROFILE ?? "default",
        provider: {
          id: "agent-observability",
          mode: "deterministic",
        },
        reportId: "recovery-observability",
        reportType: "recovery_observability",
      });

  await writeFile(jsonPath, `${JSON.stringify(writtenReport, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    formatRecoveryObservabilityReportMarkdown(writtenReport),
    "utf8"
  );

  return {
    jsonPath,
    markdownPath,
  };
};
