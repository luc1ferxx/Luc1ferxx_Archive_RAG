import {
  readLatestQualityReport,
} from "../evaluation/quality-report.js";
import { buildHealthReport } from "../health.js";
import {
  getAgentRunRecoveryMode,
  getAgentRunStoreProvider,
  getTaskStoreProvider,
  getVectorStoreProvider,
  isApiAuthEnabled,
  isStartupHealthStrict,
} from "./config.js";
import {
  AGENT_RUN_STATUSES,
} from "./agent-runs.js";
import { createDefaultAgentTriggerRegistry } from "./agent-triggers/registry.js";
import { TASK_STATUSES } from "./tasks.js";

export const ADMIN_STATUS_VALUES = Object.freeze({
  error: "error",
  ok: "ok",
  unavailable: "unavailable",
  warn: "warn",
});

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const createWarning = ({ component, id, message, severity = "warn" } = {}) => ({
  component: normalizeText(component),
  id: normalizeText(id),
  message: normalizeText(message),
  severity: normalizeText(severity) || "warn",
});

const buildUnavailableSection = ({ component, error, warnings }) => {
  warnings.push(
    createWarning({
      component,
      id: `${component}_unavailable`,
      message: `${component} status is unavailable.`,
    })
  );

  return {
    error:
      error instanceof Error
        ? {
            name: normalizeText(error.name) || "Error",
            status: Number.isFinite(Number(error.status))
              ? Number(error.status)
              : null,
          }
        : null,
    status: ADMIN_STATUS_VALUES.unavailable,
  };
};

const safeReadSection = async ({ component, read, warnings }) => {
  if (typeof read !== "function") {
    return buildUnavailableSection({
      component,
      warnings,
    });
  }

  try {
    return await read();
  } catch (error) {
    return buildUnavailableSection({
      component,
      error,
      warnings,
    });
  }
};

const safeReadOptionalSection = async ({ component, read, warnings }) => {
  if (typeof read !== "function") {
    return {
      status: ADMIN_STATUS_VALUES.unavailable,
    };
  }

  return safeReadSection({
    component,
    read,
    warnings,
  });
};

const countStatuses = ({ items = [], statuses = [] } = {}) => {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));

  for (const item of toArray(items)) {
    const status = normalizeText(item.status);

    if (Object.hasOwn(counts, status)) {
      counts[status] += 1;
    }
  }

  return counts;
};

const compactHealthCheck = (check = {}) => {
  const checkRecord = normalizeRecord(check);
  const compactCheck = {
    status: normalizeText(checkRecord.status) || "unknown",
  };

  for (const key of [
    "backend",
    "enabled",
    "provider",
    "reason",
    "recoveryMode",
    "recoveryModeReason",
  ]) {
    if (checkRecord[key] !== undefined) {
      compactCheck[key] = checkRecord[key];
    }
  }

  return compactCheck;
};

const compactHealthReport = (report = {}) => {
  const checks = normalizeRecord(report.checks);

  return {
    checkedAt: normalizeText(report.checkedAt),
    checks: Object.fromEntries(
      Object.entries(checks).map(([name, check]) => [
        name,
        compactHealthCheck(check),
      ])
    ),
    status: normalizeText(report.status) || "unknown",
  };
};

const buildHealthWarnings = ({ health = {}, warnings }) => {
  if (health.status === ADMIN_STATUS_VALUES.unavailable) {
    return;
  }

  for (const [component, check] of Object.entries(health.checks ?? {})) {
    if (check.status === "error") {
      warnings.push(
        createWarning({
          component: `health.${component}`,
          id: `health_${component}_error`,
          message: `${component} health check is failing.`,
          severity: "error",
        })
      );
    }
  }
};

export const compactAdminQualityReport = (report = {}) => {
  const summary = normalizeRecord(report.summary);
  const metrics = normalizeRecord(summary.metrics);

  return {
    corpus: normalizeRecord(summary.corpus, null)
      ? {
          cases: summary.corpus.cases ?? null,
          path: normalizeText(summary.corpus.path),
        }
      : null,
    createdAt: normalizeText(summary.createdAt),
    failedCaseCount: toArray(report.failedCases).length,
    metrics: {
      abstainAccuracyPercent: metrics.abstainAccuracyPercent ?? null,
      claimSupportHitPercent: metrics.claimSupportHitPercent ?? null,
      comparePageHitPercent: metrics.comparePageHitPercent ?? null,
      overallPassPercent: metrics.overallPassPercent ?? null,
      overallPassRate: metrics.overallPassRate ?? null,
      qaPageHitPercent: metrics.qaPageHitPercent ?? null,
    },
    runId: normalizeText(summary.runId),
    status: normalizeText(report.status) || "unknown",
  };
};

export const compactAdminLlmOpsReport = (report = {}) => {
  const llmops = normalizeRecord(report.llmops);

  if (!llmops || Object.keys(llmops).length === 0) {
    return {
      status: ADMIN_STATUS_VALUES.unavailable,
    };
  }

  const budgetExceededCount = Number(llmops.budgetExceededCount ?? 0);
  const errorCount = Number(llmops.errorCount ?? 0);
  const alertEventCount = Number(llmops.alertEventCount ?? 0);
  const latencySloBreachRate = Number(llmops.latencySloBreachRate ?? 0);
  const status =
    errorCount > 0 || budgetExceededCount > 0
      ? ADMIN_STATUS_VALUES.error
      : alertEventCount > 0 || latencySloBreachRate > 0
        ? ADMIN_STATUS_VALUES.warn
        : ADMIN_STATUS_VALUES.ok;

  return {
    alertCounts: normalizeRecord(llmops.alertCounts),
    alertEventCount: Number.isFinite(alertEventCount) ? alertEventCount : 0,
    annotationCounts: normalizeRecord(llmops.annotationCounts),
    budgetExceededCount: Number.isFinite(budgetExceededCount)
      ? budgetExceededCount
      : 0,
    budgetExceededRate: llmops.budgetExceededRate ?? 0,
    budgetStatusCounts: normalizeRecord(llmops.budgetStatusCounts),
    errorCount: Number.isFinite(errorCount) ? errorCount : 0,
    errorRate: llmops.errorRate ?? 0,
    estimatedCostUsd: llmops.estimatedCostUsd ?? 0,
    eventCount: llmops.eventCount ?? 0,
    latencySloBreachRate: Number.isFinite(latencySloBreachRate)
      ? latencySloBreachRate
      : 0,
    status,
    totalTokens: llmops.totalTokens ?? 0,
  };
};

const buildQualityWarnings = ({ quality = {}, warnings }) => {
  if (quality.status === ADMIN_STATUS_VALUES.unavailable) {
    return;
  }

  if (["fail", "warn", "unknown"].includes(quality.status)) {
    warnings.push(
      createWarning({
        component: "quality",
        id: `quality_${quality.status}`,
        message: `Quality status is ${quality.status}.`,
        severity: quality.status === "fail" ? "error" : "warn",
      })
    );
  }
};

const buildLlmOpsWarnings = ({ llmOps = {}, warnings }) => {
  if (llmOps.status === ADMIN_STATUS_VALUES.unavailable) {
    return;
  }

  if ((llmOps.errorCount ?? 0) > 0) {
    warnings.push(
      createWarning({
        component: "llmOps",
        id: "llmops_errors",
        message: "One or more LLMOps events failed.",
        severity: "error",
      })
    );
  }

  if ((llmOps.budgetExceededCount ?? 0) > 0) {
    warnings.push(
      createWarning({
        component: "llmOps",
        id: "llmops_budget_exceeded",
        message: "One or more LLMOps events exceeded budget policy.",
        severity: "error",
      })
    );
  }

  if ((llmOps.alertEventCount ?? 0) > 0) {
    warnings.push(
      createWarning({
        component: "llmOps",
        id: "llmops_alerts",
        message: "LLMOps alert events are present.",
      })
    );
  }
};

const buildDeploymentSnapshot = ({
  config = {},
  processEnv = process.env,
  processVersion = process.version,
} = {}) => ({
  agentRunRecoveryMode: config.getAgentRunRecoveryMode(),
  agentRunStoreProvider: config.getAgentRunStoreProvider(),
  apiAuthEnabled: config.isApiAuthEnabled(),
  environment: normalizeText(processEnv.NODE_ENV) || "development",
  nodeVersion: normalizeText(processVersion),
  runtime: "node",
  startupHealthStrict: config.isStartupHealthStrict(),
  taskStoreProvider: config.getTaskStoreProvider(),
  vectorStoreProvider: config.getVectorStoreProvider(),
});

const buildDeploymentWarnings = ({ deployment = {}, warnings }) => {
  if (!deployment.apiAuthEnabled) {
    warnings.push(
      createWarning({
        component: "deployment",
        id: "api_auth_disabled",
        message: "API authentication is disabled.",
      })
    );
  }

  if (!deployment.startupHealthStrict) {
    warnings.push(
      createWarning({
        component: "deployment",
        id: "startup_health_not_strict",
        message: "Startup health strict mode is disabled.",
      })
    );
  }
};

const buildTaskStatus = async ({ accessScope = {}, taskService }) => {
  const listedTasks = await taskService.listTasks({
    accessScope,
  });
  const tasks = toArray(listedTasks?.tasks);
  const counts = countStatuses({
    items: tasks,
    statuses: Object.values(TASK_STATUSES),
  });

  return {
    counts,
    failedCount: counts[TASK_STATUSES.failed] ?? 0,
    status:
      (counts[TASK_STATUSES.failed] ?? 0) > 0
        ? ADMIN_STATUS_VALUES.warn
        : ADMIN_STATUS_VALUES.ok,
    total: tasks.length,
  };
};

const buildTaskWarnings = ({ tasks = {}, warnings }) => {
  if (tasks.status === ADMIN_STATUS_VALUES.unavailable) {
    return;
  }

  if ((tasks.failedCount ?? 0) > 0) {
    warnings.push(
      createWarning({
        component: "tasks",
        id: "tasks_failed",
        message: "One or more tasks are failed.",
      })
    );
  }
};

const listRunsByStatus = async ({ accessScope = {}, agentRunService, status }) => {
  const listedRuns = await agentRunService.listRuns({
    accessScope,
    status,
  });

  return toArray(listedRuns?.runs);
};

const buildAgentRunStatus = async ({
  accessScope = {},
  agentRunRecoveryActionService,
  agentRunService,
}) => {
  const runEntries = await Promise.all(
    Object.values(AGENT_RUN_STATUSES).map(async (status) => [
      status,
      await listRunsByStatus({
        accessScope,
        agentRunService,
        status,
      }),
    ])
  );
  const counts = Object.fromEntries(
    runEntries.map(([status, runs]) => [status, runs.length])
  );
  const recoveryRuns = agentRunRecoveryActionService?.listRecoveryRuns
    ? toArray(
        (
          await agentRunRecoveryActionService.listRecoveryRuns({
            accessScope,
          })
        )?.runs
      )
    : [];
  const manualRecoveryCount = recoveryRuns.filter(
    (run) =>
      run.recovery?.required === true ||
      toArray(run.recovery?.actions).length > 0 ||
      run.result?.recovery?.mode === "manual"
  ).length;
  const failedCount = counts[AGENT_RUN_STATUSES.failed] ?? 0;
  const recoveryCount = recoveryRuns.length;

  return {
    counts,
    failedCount,
    manualRecoveryCount,
    recoveryCount,
    status:
      failedCount > 0 || recoveryCount > 0
        ? ADMIN_STATUS_VALUES.warn
        : ADMIN_STATUS_VALUES.ok,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
};

const buildAgentRunWarnings = ({ agentRuns = {}, warnings }) => {
  if (agentRuns.status === ADMIN_STATUS_VALUES.unavailable) {
    return;
  }

  if ((agentRuns.failedCount ?? 0) > 0) {
    warnings.push(
      createWarning({
        component: "agentRuns",
        id: "agent_runs_failed",
        message: "One or more agent runs are failed.",
      })
    );
  }

  if ((agentRuns.recoveryCount ?? 0) > 0) {
    warnings.push(
      createWarning({
        component: "agentRuns",
        id: "agent_runs_need_recovery",
        message: "One or more agent runs need recovery attention.",
      })
    );
  }
};

const buildTriggerStatus = ({ triggerRegistry }) => {
  const triggers = triggerRegistry.listPublic({
    enabledOnly: false,
  });
  const enabledCount = toArray(triggers).filter(
    (trigger) => trigger.enabled === true
  ).length;
  const total = toArray(triggers).length;

  return {
    disabledCount: total - enabledCount,
    enabledCount,
    status: total > 0 ? ADMIN_STATUS_VALUES.ok : ADMIN_STATUS_VALUES.warn,
    total,
  };
};

const buildTriggerWarnings = ({ triggers = {}, warnings }) => {
  if (triggers.status === ADMIN_STATUS_VALUES.unavailable) {
    return;
  }

  if ((triggers.enabledCount ?? 0) === 0) {
    warnings.push(
      createWarning({
        component: "triggers",
        id: "no_enabled_triggers",
        message: "No automation triggers are enabled.",
      })
    );
  }
};

const buildOverallStatus = ({ health = {}, quality = {}, warnings = [] } = {}) => {
  if (
    health.status === ADMIN_STATUS_VALUES.error ||
    quality.status === "fail" ||
    warnings.some((warning) => warning.severity === "error")
  ) {
    return ADMIN_STATUS_VALUES.error;
  }

  if (
    health.status === ADMIN_STATUS_VALUES.unavailable ||
    quality.status === ADMIN_STATUS_VALUES.unavailable ||
    warnings.length > 0
  ) {
    return ADMIN_STATUS_VALUES.warn;
  }

  return ADMIN_STATUS_VALUES.ok;
};

const defaultConfig = {
  getAgentRunRecoveryMode,
  getAgentRunStoreProvider,
  getTaskStoreProvider,
  getVectorStoreProvider,
  isApiAuthEnabled,
  isStartupHealthStrict,
};

export const createAdminStatusService = ({
  agentRunRecoveryActionService = null,
  agentRunService = null,
  config = defaultConfig,
  healthService = {
    buildHealthReport,
  },
  llmOpsService = null,
  now = () => new Date().toISOString(),
  processEnv = process.env,
  processVersion = process.version,
  qualityService = {
    readLatestQualityReport,
  },
  taskService = null,
  triggerRegistry = createDefaultAgentTriggerRegistry(),
} = {}) => ({
  async buildStatus({ accessScope = {} } = {}) {
    const warnings = [];
    const runtimeConfig = {
      ...defaultConfig,
      ...normalizeRecord(config),
    };
    const deployment = buildDeploymentSnapshot({
      config: runtimeConfig,
      processEnv,
      processVersion,
    });
    const [health, quality, llmOps, tasks, agentRuns, triggers] = await Promise.all([
      safeReadSection({
        component: "health",
        read: async () =>
          compactHealthReport(await healthService.buildHealthReport()),
        warnings,
      }),
      safeReadSection({
        component: "quality",
        read: async () =>
          compactAdminQualityReport(await qualityService.readLatestQualityReport()),
        warnings,
      }),
      safeReadOptionalSection({
        component: "llmOps",
        read: llmOpsService?.readLatestObservabilityReport
          ? async () =>
              compactAdminLlmOpsReport(
                await llmOpsService.readLatestObservabilityReport()
              )
          : null,
        warnings,
      }),
      safeReadSection({
        component: "tasks",
        read: taskService?.listTasks
          ? () =>
              buildTaskStatus({
                accessScope,
                taskService,
              })
          : null,
        warnings,
      }),
      safeReadSection({
        component: "agentRuns",
        read: agentRunService?.listRuns
          ? () =>
              buildAgentRunStatus({
                accessScope,
                agentRunRecoveryActionService,
                agentRunService,
              })
          : null,
        warnings,
      }),
      safeReadSection({
        component: "triggers",
        read: triggerRegistry?.listPublic
          ? () =>
              buildTriggerStatus({
                triggerRegistry,
              })
          : null,
        warnings,
      }),
    ]);

    buildDeploymentWarnings({
      deployment,
      warnings,
    });
    buildHealthWarnings({
      health,
      warnings,
    });
    buildQualityWarnings({
      quality,
      warnings,
    });
    buildLlmOpsWarnings({
      llmOps,
      warnings,
    });
    buildTaskWarnings({
      tasks,
      warnings,
    });
    buildAgentRunWarnings({
      agentRuns,
      warnings,
    });
    buildTriggerWarnings({
      triggers,
      warnings,
    });

    return {
      agentRuns,
      checkedAt: now(),
      deployment,
      health,
      llmOps,
      quality,
      status: buildOverallStatus({
        health,
        quality,
        warnings,
      }),
      tasks,
      triggers,
      warnings,
    };
  },
});
