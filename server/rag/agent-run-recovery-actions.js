import {
  AGENT_RUN_STATUSES,
  isRetryableAgentRunStatus,
} from "./agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "./agent-run-steps.js";
import {
  DEFAULT_AUTO_RECOVERY_STEP_TYPES,
  MANUAL_RECOVERY_EVENT,
  findAutoRecoverableStep,
} from "./agent-run-recovery.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeAction = (value) => normalizeText(value).toLowerCase();

const toArray = (value) => (Array.isArray(value) ? value : []);

export const AGENT_RUN_RECOVERY_ACTIONS = Object.freeze({
  cancel: "cancel",
  resumeFromStep: "resume_from_step",
  retryFailedStep: "retry_failed_step",
});

const ACTION_STATUSES = Object.freeze([
  AGENT_RUN_STATUSES.waitingForUser,
  AGENT_RUN_STATUSES.running,
  AGENT_RUN_STATUSES.failed,
  AGENT_RUN_STATUSES.completed,
]);

const RESUMABLE_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.waitingForUser,
  AGENT_RUN_STATUSES.running,
]);

const FAILED_STEP_STATUSES = new Set([AGENT_RUN_STEP_STATUSES.failed]);

const hasManualRecoveryEvent = (run = {}) =>
  toArray(run.events).some((event) => event.type === MANUAL_RECOVERY_EVENT);

const getRecoveryRecord = (run = {}) =>
  run.result && typeof run.result === "object" && !Array.isArray(run.result)
    ? run.result.recovery
    : null;

const isManualRecoveryRun = (run = {}) =>
  run.status === AGENT_RUN_STATUSES.waitingForUser &&
  (hasManualRecoveryEvent(run) || getRecoveryRecord(run)?.mode === "manual");

const findFailedStep = (run = {}) =>
  [...toArray(run.steps)]
    .reverse()
    .find((step) => step?.id && FAILED_STEP_STATUSES.has(step.status)) ?? null;

const sortRunsByUpdatedAtDesc = (runs = []) =>
  [...runs].sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt))
  );

const findRecoveryAction = ({ actions = [], stepId = "", type } = {}) => {
  const normalizedStepId = normalizeText(stepId);

  return actions.find(
    (action) =>
      action.type === type &&
      (!normalizedStepId || action.stepId === normalizedStepId)
  );
};

const buildStepAction = ({ reason, step, type } = {}) => ({
  label: step?.label ?? step?.type ?? "Step",
  reason,
  stepId: step?.id ?? "",
  stepType: step?.type ?? "",
  type,
});

export const buildAgentRunRecoveryState = ({
  run = {},
  safeAutoRecoveryStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => {
  const recoveryRecord = getRecoveryRecord(run);
  const resumeCandidate = findAutoRecoverableStep({
    run,
    safeStepTypes: safeAutoRecoveryStepTypes,
  });
  const failedStep = findFailedStep(run);
  const actions = [];

  if (
    isManualRecoveryRun(run) &&
    RESUMABLE_RUN_STATUSES.has(run.status) &&
    resumeCandidate.step
  ) {
    actions.push(
      buildStepAction({
        reason: resumeCandidate.reason,
        step: resumeCandidate.step,
        type: AGENT_RUN_RECOVERY_ACTIONS.resumeFromStep,
      })
    );
  }

  if (isRetryableAgentRunStatus(run.status) && failedStep) {
    actions.push(
      buildStepAction({
        reason: "failed_step_ready",
        step: failedStep,
        type: AGENT_RUN_RECOVERY_ACTIONS.retryFailedStep,
      })
    );
  }

  if (isManualRecoveryRun(run) && RESUMABLE_RUN_STATUSES.has(run.status)) {
    actions.push({
      label: "Cancel run",
      reason: recoveryRecord?.reason ?? resumeCandidate.reason,
      stepId: "",
      stepType: "",
      type: AGENT_RUN_RECOVERY_ACTIONS.cancel,
    });
  }

  return {
    actions,
    reason:
      recoveryRecord?.reason ??
      (failedStep ? "failed_step_ready" : resumeCandidate.reason),
    required: actions.length > 0,
    requestedMode: recoveryRecord?.requestedMode ?? recoveryRecord?.mode ?? "",
    stepId: recoveryRecord?.stepId ?? resumeCandidate.step?.id ?? failedStep?.id ?? "",
  };
};

export const withAgentRunRecoveryState = ({
  run,
  safeAutoRecoveryStepTypes,
} = {}) => ({
  ...run,
  recovery: buildAgentRunRecoveryState({
    run,
    safeAutoRecoveryStepTypes,
  }),
});

export const createAgentRunRecoveryActionService = ({
  agentRunService,
  agentRunStepExecutor,
  safeAutoRecoveryStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => {
  const listActionableRuns = async ({ accessScope = {} } = {}) => {
    const runById = new Map();

    for (const status of ACTION_STATUSES) {
      const listedRuns = await agentRunService.listRuns?.({
        accessScope,
        status,
      });

      for (const run of listedRuns?.runs ?? []) {
        runById.set(run.runId, run);
      }
    }

    return sortRunsByUpdatedAtDesc([...runById.values()])
      .map((run) =>
        withAgentRunRecoveryState({
          run,
          safeAutoRecoveryStepTypes,
        })
      )
      .filter((run) => run.recovery.required);
  };

  const getActionableRun = async ({ accessScope = {}, runId } = {}) => {
    const run = await agentRunService.getRun?.({
      accessScope,
      runId,
    });

    if (!run) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

    return withAgentRunRecoveryState({
      run,
      safeAutoRecoveryStepTypes,
    });
  };

  return {
    async listRecoveryRuns({ accessScope = {} } = {}) {
      return {
        runs: await listActionableRuns({
          accessScope,
        }),
      };
    },

    async applyRecoveryAction({
      accessScope = {},
      action,
      payload = {},
      runId,
    } = {}) {
      const normalizedAction = normalizeAction(action);

      if (!Object.values(AGENT_RUN_RECOVERY_ACTIONS).includes(normalizedAction)) {
        const error = new Error(`Unsupported agent run recovery action: ${action}`);
        error.status = 400;
        throw error;
      }

      const run = await getActionableRun({
        accessScope,
        runId,
      });
      const stepId = normalizeText(payload.stepId);

      if (normalizedAction === AGENT_RUN_RECOVERY_ACTIONS.cancel) {
        const cancelAction = findRecoveryAction({
          actions: run.recovery.actions,
          type: AGENT_RUN_RECOVERY_ACTIONS.cancel,
        });

        if (!cancelAction) {
          const error = new Error("Agent run is not waiting for manual recovery.");
          error.status = 409;
          throw error;
        }

        return {
          run: await agentRunService.cancelRun({
            accessScope,
            reason: payload.reason ?? "manual_recovery_cancel",
            runId,
          }),
        };
      }

      if (normalizedAction === AGENT_RUN_RECOVERY_ACTIONS.resumeFromStep) {
        if (!agentRunStepExecutor?.resumeStep) {
          const error = new Error("Agent run step resume is not available.");
          error.status = 409;
          throw error;
        }

        const resumeAction = findRecoveryAction({
          actions: run.recovery.actions,
          stepId,
          type: AGENT_RUN_RECOVERY_ACTIONS.resumeFromStep,
        });

        if (!resumeAction) {
          const error = new Error("Agent run has no safe step to resume.");
          error.status = 409;
          throw error;
        }

        return agentRunStepExecutor.resumeStep({
          accessScope,
          runId,
          stepId: stepId || resumeAction.stepId,
        });
      }

      const retryAction = findRecoveryAction({
        actions: run.recovery.actions,
        stepId,
        type: AGENT_RUN_RECOVERY_ACTIONS.retryFailedStep,
      });

      if (!retryAction) {
        const error = new Error("Agent run has no failed step to retry.");
        error.status = 409;
        throw error;
      }

      if (!agentRunStepExecutor?.retryStep) {
        const error = new Error("Agent run step retry is not available.");
        error.status = 409;
        throw error;
      }

      return agentRunStepExecutor.retryStep({
        accessScope,
        runId,
        stepId: stepId || retryAction.stepId,
      });
    },
  };
};
