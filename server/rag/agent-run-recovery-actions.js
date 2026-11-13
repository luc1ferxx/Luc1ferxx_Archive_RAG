import {
  AGENT_RUN_STATUSES,
  isRetryableAgentRunStatus,
} from "./agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "./agent-run-steps.js";
import {
  INTERRUPTED_STEP_STATUS_VALUES,
  MANUAL_RECOVERY_EVENT,
  explainInterruptedRun,
} from "./agent-run-recovery.js";
import {
  buildStepReplaySafetyAssessment,
  isStepRetryAllowed,
} from "./agent-run-step-replay-safety.js";
import { recordRagTrace } from "./observability.js";
import { normalizeText } from "../lib/normalize-text.js";

const normalizeAction = (value) => normalizeText(value).toLowerCase();

const toArray = (value) => (Array.isArray(value) ? value : []);

// What an operator can do with a run from the recovery panel. There is no
// "resume from step": a step is never replayed on its own, and an interrupted
// graph is continued by startup recovery, not from here.
export const AGENT_RUN_RECOVERY_ACTIONS = Object.freeze({
  cancel: "cancel",
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
const RECOVERY_REPLAY_STEP_STATUSES = new Set([
  ...INTERRUPTED_STEP_STATUS_VALUES,
  AGENT_RUN_STEP_STATUSES.failed,
]);

const hasManualRecoveryEvent = (run = {}) =>
  toArray(run.events).some((event) => event.type === MANUAL_RECOVERY_EVENT);

const getRecoveryRecord = (run = {}) =>
  run.result && typeof run.result === "object" && !Array.isArray(run.result)
    ? run.result.recovery
    : null;

const isManualRecoveryRun = (run = {}) =>
  run.status === AGENT_RUN_STATUSES.waitingForUser &&
  (hasManualRecoveryEvent(run) || getRecoveryRecord(run)?.mode === "manual");

// The run's last failed step, when its type can be retried on its own. A
// failed graph node cannot (a custom Skill runs only inside its graph), so it
// is not offered: the retry would always be refused.
const findRetryableFailedStep = (run = {}) => {
  const failedStep =
    [...toArray(run.steps)]
      .reverse()
      .find((step) => step?.id && FAILED_STEP_STATUSES.has(step.status)) ?? null;

  return failedStep && isStepRetryAllowed(failedStep.type) ? failedStep : null;
};

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

const buildStepAction = ({ reason, safety = null, step, type } = {}) => ({
  label: step?.label ?? step?.type ?? "Step",
  reason,
  safety,
  stepId: step?.id ?? "",
  stepType: step?.type ?? "",
  type,
});

// What replaying each interrupted or failed step would risk or lack.
const buildAgentRunReplaySafetyState = ({ run = {} } = {}) => {
  const steps = toArray(run.steps)
    .filter(
      (step) => step?.id && RECOVERY_REPLAY_STEP_STATUSES.has(step.status)
    )
    .map((step) => ({
      ...buildStepReplaySafetyAssessment({ run, step }),
      kind: step.kind ?? "",
      status: step.status ?? "",
    }));
  const reasonCodes = [
    ...new Set(steps.flatMap((step) => step.reasonCodes ?? [])),
  ];

  return {
    reasonCodes,
    steps,
  };
};

export const buildAgentRunRecoveryState = ({ run = {} } = {}) => {
  const recoveryRecord = getRecoveryRecord(run);
  const interrupted = explainInterruptedRun({ run });
  const failedStep = findRetryableFailedStep(run);
  const replaySafety = buildAgentRunReplaySafetyState({ run });
  const safetyByStepId = new Map(
    replaySafety.steps.map((stepSafety) => [stepSafety.stepId, stepSafety])
  );
  const actions = [];

  if (isRetryableAgentRunStatus(run.status) && failedStep) {
    actions.push(
      buildStepAction({
        reason: "failed_step_ready",
        safety: safetyByStepId.get(failedStep.id) ?? null,
        step: failedStep,
        type: AGENT_RUN_RECOVERY_ACTIONS.retryFailedStep,
      })
    );
  }

  if (isManualRecoveryRun(run) && RESUMABLE_RUN_STATUSES.has(run.status)) {
    actions.push({
      label: "Cancel run",
      reason: recoveryRecord?.reason ?? interrupted.reason,
      stepId: "",
      stepType: "",
      type: AGENT_RUN_RECOVERY_ACTIONS.cancel,
    });
  }

  return {
    actions,
    reason:
      recoveryRecord?.reason ??
      (failedStep ? "failed_step_ready" : interrupted.reason),
    required: actions.length > 0,
    requestedMode: recoveryRecord?.requestedMode ?? recoveryRecord?.mode ?? "",
    replaySafety,
    stepId: recoveryRecord?.stepId ?? failedStep?.id ?? "",
  };
};

export const withAgentRunRecoveryState = ({ run } = {}) => ({
  ...run,
  recovery: buildAgentRunRecoveryState({ run }),
});

export const createAgentRunRecoveryActionService = ({
  agentRunService,
  agentRunStepExecutor,
  now = () => new Date().toISOString(),
  recordRecoveryTrace = recordRagTrace,
} = {}) => {
  const listActionableRuns = async ({ accessScope = {} } = {}) => {
    const runById = new Map();

    for (const status of ACTION_STATUSES) {
      const listedRuns = await agentRunService.listRuns?.({
        accessScope,
        status,
        // Recovery must see every run; a capped page would hide stuck runs.
        limit: "all",
      });

      for (const run of listedRuns?.runs ?? []) {
        runById.set(run.runId, run);
      }
    }

    return sortRunsByUpdatedAtDesc([...runById.values()])
      .map((run) => withAgentRunRecoveryState({ run }))
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

    return withAgentRunRecoveryState({ run });
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
      let selectedStepId = stepId;
      const recordActionTrace = async ({ error, result } = {}) =>
        recordRecoveryTrace?.({
          traceType: "agent_run_recovery",
          timestamp: now(),
          eventType: "manual_recovery_action",
          action: normalizedAction,
          runId,
          runStatus: result?.run?.status ?? run.status,
          stepId: selectedStepId || null,
          status: error ? "failed" : "completed",
          error: error
            ? {
                message: error instanceof Error ? error.message : String(error),
                status: error?.status ?? 500,
              }
            : null,
        });

      const applyAction = async () => {
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

        selectedStepId = stepId || retryAction.stepId;

        return agentRunStepExecutor.retryStep({
          accessScope,
          runId,
          stepId: selectedStepId,
        });
      };

      try {
        const result = await applyAction();

        await recordActionTrace({
          result,
        });

        return result;
      } catch (error) {
        await recordActionTrace({
          error,
        });
        throw error;
      }
    },
  };
};
