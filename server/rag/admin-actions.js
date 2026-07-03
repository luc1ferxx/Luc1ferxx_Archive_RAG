import { compactAdminQualityReport } from "./admin-status.js";

export const ADMIN_ACTION_IDS = Object.freeze({
  qualityRefresh: "quality-refresh",
  recoverTasks: "recover-tasks",
  recoveryScan: "recovery-scan",
});

export const ADMIN_ACTION_STATUSES = Object.freeze({
  completed: "completed",
});

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const createAdminActionError = ({ message, status = 500 } = {}) => {
  const error = new Error(message);
  error.expose = true;
  error.status = status;
  return error;
};

const buildActionResult = ({ action, result }) => ({
  action: {
    id: action.id,
    label: action.label,
  },
  result,
  status: ADMIN_ACTION_STATUSES.completed,
});

const requireActionHandler = ({ handler, name }) => {
  if (typeof handler !== "function") {
    throw createAdminActionError({
      message: `${name} admin action is unavailable.`,
      status: 503,
    });
  }

  return handler;
};

const compactRecoveryAction = (action = {}) => ({
  label: normalizeText(action.label),
  reason: normalizeText(action.reason),
  safety: action.safety
    ? {
        canAutoReplay: action.safety.canAutoReplay === true,
        reasonCodes: toArray(action.safety.reasonCodes).map(normalizeText),
      }
    : null,
  stepId: normalizeText(action.stepId),
  stepType: normalizeText(action.stepType),
  type: normalizeText(action.type),
});

const compactRecoveryRun = (run = {}) => {
  const recovery = normalizeRecord(run.recovery);
  const actions = toArray(recovery.actions).map(compactRecoveryAction);

  return {
    recovery: {
      actionCount: actions.length,
      actions,
      reason: normalizeText(recovery.reason),
      requestedMode: normalizeText(recovery.requestedMode),
      required: recovery.required === true,
      replaySafety: recovery.replaySafety
        ? {
            canAutoReplay: recovery.replaySafety.canAutoReplay === true,
            reasonCodes: toArray(recovery.replaySafety.reasonCodes).map(
              normalizeText
            ),
            stepCount: toArray(recovery.replaySafety.steps).length,
          }
        : null,
      stepId: normalizeText(recovery.stepId),
    },
    runId: normalizeText(run.runId),
    status: normalizeText(run.status),
    updatedAt: normalizeText(run.updatedAt),
  };
};

const countBy = (items = [], getKey) => {
  const counts = {};

  for (const item of toArray(items)) {
    const key = normalizeText(getKey(item));

    if (key) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  return counts;
};

const buildRecoveryScanResult = (runs = []) => {
  const compactRuns = toArray(runs).map(compactRecoveryRun);
  const actions = compactRuns.flatMap((run) => run.recovery.actions);

  return {
    actionCount: actions.length,
    actionsByType: countBy(actions, (action) => action.type),
    runs: compactRuns,
    runsByStatus: countBy(compactRuns, (run) => run.status),
    total: compactRuns.length,
  };
};

const createRecoverTasksAction = ({ jobOrchestrator }) => ({
  id: ADMIN_ACTION_IDS.recoverTasks,
  label: "Recover runnable tasks",
  async run() {
    const recoverRunnableTasks = requireActionHandler({
      handler: jobOrchestrator?.recoverRunnableTasks,
      name: "Recover tasks",
    });
    const result = await recoverRunnableTasks();

    return {
      scheduledCount: Number(result?.scheduledCount ?? 0),
    };
  },
});

const createRecoveryScanAction = ({ agentRunRecoveryActionService }) => ({
  id: ADMIN_ACTION_IDS.recoveryScan,
  label: "Scan recoverable agent runs",
  async run({ accessScope }) {
    const listRecoveryRuns = requireActionHandler({
      handler: agentRunRecoveryActionService?.listRecoveryRuns,
      name: "Recovery scan",
    });
    const result = await listRecoveryRuns({
      accessScope,
    });

    return buildRecoveryScanResult(result?.runs);
  },
});

const createQualityRefreshAction = ({ qualityService }) => ({
  id: ADMIN_ACTION_IDS.qualityRefresh,
  label: "Refresh quality report",
  async run({ payload }) {
    const runSyntheticQualityEvaluation = requireActionHandler({
      handler: qualityService?.runSyntheticQualityEvaluation,
      name: "Quality refresh",
    });
    const report = await runSyntheticQualityEvaluation({
      corpusPath: normalizeText(payload?.corpusPath),
    });

    return {
      quality: compactAdminQualityReport(report),
    };
  },
});

const createActions = ({
  agentRunRecoveryActionService,
  jobOrchestrator,
  qualityService,
} = {}) => [
  createRecoverTasksAction({
    jobOrchestrator,
  }),
  createRecoveryScanAction({
    agentRunRecoveryActionService,
  }),
  createQualityRefreshAction({
    qualityService,
  }),
];

export const createAdminActionRegistry = ({
  agentRunRecoveryActionService = null,
  jobOrchestrator = null,
  qualityService = null,
} = {}) => {
  const actions = createActions({
    agentRunRecoveryActionService,
    jobOrchestrator,
    qualityService,
  });
  const actionById = new Map(actions.map((action) => [action.id, action]));

  return {
    listActions() {
      return actions.map((action) => ({
        id: action.id,
        label: action.label,
      }));
    },

    async runAction({ accessScope = {}, actionId, payload = {} } = {}) {
      const action = actionById.get(normalizeText(actionId).toLowerCase());

      if (!action) {
        throw createAdminActionError({
          message: "Admin action not found.",
          status: 404,
        });
      }

      return buildActionResult({
        action,
        result: await action.run({
          accessScope,
          payload: normalizeRecord(payload),
        }),
      });
    },
  };
};
