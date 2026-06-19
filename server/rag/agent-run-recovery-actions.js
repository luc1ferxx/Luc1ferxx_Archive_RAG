import {
  AGENT_RUN_STATUSES,
  isRetryableAgentRunStatus,
} from "./agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "./agent-run-steps.js";
import {
  AUTO_RECOVERY_STEP_STATUS_VALUES,
  DEFAULT_AUTO_RECOVERY_STEP_TYPES,
  MANUAL_RECOVERY_EVENT,
  findAutoRecoverableStep,
} from "./agent-run-recovery.js";
import {
  buildStepReplaySafetyAssessment,
} from "./agent-run-step-replay-safety.js";
import { recordRagTrace } from "./observability.js";

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
const RECOVERY_REPLAY_STEP_STATUSES = new Set([
  ...AUTO_RECOVERY_STEP_STATUS_VALUES,
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

const buildStepAction = ({ reason, safety = null, step, type } = {}) => ({
  label: step?.label ?? step?.type ?? "Step",
  reason,
  safety,
  stepId: step?.id ?? "",
  stepType: step?.type ?? "",
  type,
});

const buildAgentRunReplaySafetyState = ({
  run = {},
  safeAutoRecoveryStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => {
  const steps = toArray(run.steps)
    .filter(
      (step) => step?.id && RECOVERY_REPLAY_STEP_STATUSES.has(step.status)
    )
    .map((step) => ({
      ...buildStepReplaySafetyAssessment({
        autoReplayStepTypes: safeAutoRecoveryStepTypes,
        run,
        step,
      }),
      kind: step.kind ?? "",
      status: step.status ?? "",
    }));
  const reasonCodes = [
    ...new Set(steps.flatMap((step) => step.reasonCodes ?? [])),
  ];

  return {
    canAutoReplay: steps.some(
      (step) =>
        step.canAutoReplay && AUTO_RECOVERY_STEP_STATUS_VALUES.includes(step.status)
    ),
    reasonCodes,
    steps,
  };
};

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
  const replaySafety = buildAgentRunReplaySafetyState({
    run,
    safeAutoRecoveryStepTypes,
  });
  const safetyByStepId = new Map(
    replaySafety.steps.map((stepSafety) => [stepSafety.stepId, stepSafety])
  );
  const actions = [];

  if (
    isManualRecoveryRun(run) &&
    RESUMABLE_RUN_STATUSES.has(run.status) &&
    resumeCandidate.step
  ) {
    actions.push(
      buildStepAction({
        reason: resumeCandidate.reason,
        safety:
          resumeCandidate.safety ??
          safetyByStepId.get(resumeCandidate.step.id) ??
          null,
        step: resumeCandidate.step,
        type: AGENT_RUN_RECOVERY_ACTIONS.resumeFromStep,
      })
    );
  }

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
    replaySafety,
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
  now = () => new Date().toISOString(),
  recordRecoveryTrace = recordRagTrace,
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

          selectedStepId = stepId || resumeAction.stepId;

          return agentRunStepExecutor.resumeStep({
            accessScope,
            runId,
            stepId: selectedStepId,
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
