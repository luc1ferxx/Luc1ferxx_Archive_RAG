import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "./agent-run-steps.js";
import {
  buildStepReplaySafetyAssessment,
  getAutoReplaySafeStepTypes,
} from "./agent-run-step-replay-safety.js";
import { recordRagTrace } from "./observability.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeMode = (value) => {
  const mode = normalizeText(value).toLowerCase();

  return ["auto", "manual", "off"].includes(mode) ? mode : "manual";
};

const toArray = (value) => (Array.isArray(value) ? value : []);

export const MANUAL_RECOVERY_EVENT = "manual_recovery_required";
const AUTO_RECOVERY_STARTED_EVENT = "auto_recovery_started";
const AUTO_RECOVERY_COMPLETED_EVENT = "auto_recovery_completed";
const AUTO_RECOVERY_FAILED_EVENT = "auto_recovery_failed";

export const DEFAULT_AUTO_RECOVERY_STEP_TYPES = Object.freeze(
  getAutoReplaySafeStepTypes()
);

export const AUTO_RECOVERY_STEP_STATUS_VALUES = Object.freeze([
  AGENT_RUN_STEP_STATUSES.paused,
  AGENT_RUN_STEP_STATUSES.pending,
  AGENT_RUN_STEP_STATUSES.running,
]);

const AUTO_RECOVERY_STEP_STATUSES = new Set(AUTO_RECOVERY_STEP_STATUS_VALUES);

const hasManualRecoveryEvent = (run = {}) =>
  toArray(run.events).some((event) => event.type === MANUAL_RECOVERY_EVENT);

const hasPendingApprovalGate = (run = {}) =>
  toArray(run.approvalGates).some(
    (gate) => normalizeText(gate.status).toLowerCase() === "pending"
  ) ||
  toArray(run.steps).some(
    (step) =>
      step.kind === AGENT_RUN_STEP_KINDS.approvalGate &&
      AUTO_RECOVERY_STEP_STATUSES.has(step.status)
  );

export const findAutoRecoverableStep = ({
  run = {},
  safeStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => {
  if (hasPendingApprovalGate(run)) {
    return {
      reason: "pending_approval_gate",
      safety: null,
      step: null,
    };
  }

  const assessments = toArray(run.steps)
    .filter((runStep) => AUTO_RECOVERY_STEP_STATUSES.has(runStep.status))
    .map((runStep) =>
      buildStepReplaySafetyAssessment({
        autoReplayStepTypes: safeStepTypes,
        run,
        step: runStep,
      })
    );
  const safeAssessment =
    assessments.find((assessment) => assessment.canAutoReplay) ?? null;
  const blockedAssessment =
    assessments.find((assessment) => assessment.reasonCodes.length > 0) ?? null;
  const step = safeAssessment
    ? toArray(run.steps).find((runStep) => runStep.id === safeAssessment.stepId)
    : null;

  return {
    reason: safeAssessment
      ? "safe_step_ready"
      : blockedAssessment?.reasonCodes[0] ?? "no_safe_recoverable_step",
    safety: safeAssessment ?? blockedAssessment,
    step: step ?? null,
  };
};

const serializeError = (error, fallbackMessage) =>
  error instanceof Error ? error.message : fallbackMessage;

const buildRecoveryPatch = ({
  mode,
  now,
  requestedMode = mode,
  reason,
  run,
  step,
} = {}) => {
  const recovery = {
    mode,
    originalStatus: run.status,
    reason,
    recoveredAt: now(),
  };

  if (requestedMode && requestedMode !== mode) {
    recovery.requestedMode = requestedMode;
  }

  if (step?.id) {
    recovery.stepId = step.id;
    recovery.stepType = step.type ?? null;
  }

  return {
    result: {
      recovery,
    },
    status:
      mode === "auto"
        ? run.status
        : run.status === AGENT_RUN_STATUSES.running
          ? AGENT_RUN_STATUSES.waitingForUser
          : run.status,
  };
};

export const createAgentRunRecoveryService = ({
  agentRunService,
  agentRunStepExecutor,
  now = () => new Date().toISOString(),
  recordRecoveryTrace = recordRagTrace,
  safeAutoRecoveryStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => ({
  async recoverOnStartup({
    mode = "manual",
    reason = "server_startup_recovery",
    statuses = [
      AGENT_RUN_STATUSES.running,
      AGENT_RUN_STATUSES.waitingForUser,
    ],
  } = {}) {
    const recoveryMode = normalizeMode(mode);

    if (recoveryMode === "off") {
      return {
        autoRecoveredCount: 0,
        failedCount: 0,
        manualRecoveredCount: 0,
        mode: recoveryMode,
        recoveredCount: 0,
        skippedCount: 0,
        runs: [],
      };
    }

    if (!agentRunService?.listRecoverableRuns) {
      return {
        autoRecoveredCount: 0,
        failedCount: 0,
        manualRecoveredCount: 0,
        mode: recoveryMode,
        recoveredCount: 0,
        skippedCount: 0,
        runs: [],
      };
    }

    const recoverableRuns = await agentRunService.listRecoverableRuns({
      includeAccessScope: true,
      statuses,
    });
    const recovered = [];
    let autoRecoveredCount = 0;
    let failedCount = 0;
    let manualRecoveredCount = 0;
    let skippedCount = 0;

    const markManualRecovery = async ({
      accessScope = {},
      fallbackReason,
      requestedMode,
      run,
      step,
    } = {}) => {
      const recoveryPatch = buildRecoveryPatch({
        mode: "manual",
        now,
        reason: fallbackReason,
        requestedMode,
        run,
        step,
      });
      const updatedRun = await agentRunService.updateRun({
        accessScope,
        runId: run.runId,
        patch: recoveryPatch,
      });

      await agentRunService.appendRunEvent?.({
        accessScope,
        runId: run.runId,
        type: MANUAL_RECOVERY_EVENT,
        payload: {
          mode: "manual",
          originalStatus: run.status,
          reason: fallbackReason,
          requestedMode,
          status: updatedRun?.status ?? recoveryPatch.status,
          stepId: step?.id ?? null,
          stepType: step?.type ?? null,
        },
      });

      manualRecoveredCount += 1;
      recovered.push(
        (await agentRunService.getRun?.({
          accessScope,
          runId: run.runId,
        })) ?? updatedRun
      );
    };

    const runAutoRecovery = async ({ accessScope = {}, run, step } = {}) => {
      const recoveryPatch = buildRecoveryPatch({
        mode: "auto",
        now,
        reason,
        requestedMode: "auto",
        run,
        step,
      });

      await agentRunService.updateRun({
        accessScope,
        runId: run.runId,
        patch: recoveryPatch,
      });
      await agentRunService.appendRunEvent?.({
        accessScope,
        runId: run.runId,
        type: AUTO_RECOVERY_STARTED_EVENT,
        payload: {
          originalStatus: run.status,
          reason,
          stepId: step.id,
          stepType: step.type,
        },
      });

      try {
        const result = await agentRunStepExecutor.resumeStep({
          accessScope,
          runId: run.runId,
          stepId: step.id,
        });

        await agentRunService.appendRunEvent?.({
          accessScope,
          runId: run.runId,
          type: AUTO_RECOVERY_COMPLETED_EVENT,
          payload: {
            status: result.run?.status ?? null,
            stepId: step.id,
            stepType: step.type,
          },
        });

        autoRecoveredCount += 1;
        recovered.push(
          (await agentRunService.getRun?.({
            accessScope,
            runId: run.runId,
          })) ?? result.run
        );
      } catch (error) {
        await agentRunService.appendRunEvent?.({
          accessScope,
          runId: run.runId,
          type: AUTO_RECOVERY_FAILED_EVENT,
          payload: {
            error: serializeError(error, "Auto recovery failed."),
            status: error?.status ?? 500,
            stepId: step.id,
            stepType: step.type,
          },
        });
        failedCount += 1;
      }
    };

    for (const listedRun of recoverableRuns.runs ?? []) {
      const accessScope = listedRun.accessScope ?? {};
      const run =
        (await agentRunService.getRun?.({
          accessScope,
          runId: listedRun.runId,
        })) ?? listedRun;

      if (hasManualRecoveryEvent(run)) {
        skippedCount += 1;
        continue;
      }

      if (recoveryMode === "auto") {
        const autoCandidate = findAutoRecoverableStep({
          run,
          safeStepTypes: safeAutoRecoveryStepTypes,
        });

        if (autoCandidate.step && agentRunStepExecutor?.resumeStep) {
          await runAutoRecovery({
            accessScope,
            run,
            step: autoCandidate.step,
          });
          continue;
        }

        await markManualRecovery({
          accessScope,
          fallbackReason: agentRunStepExecutor?.resumeStep
            ? autoCandidate.reason
            : "auto_recovery_executor_unavailable",
          requestedMode: "auto",
          run,
          step: autoCandidate.step,
        });
        continue;
      }

      await markManualRecovery({
        accessScope,
        fallbackReason: reason,
        requestedMode: recoveryMode,
        run,
      });
    }

    await recordRecoveryTrace?.({
      traceType: "agent_run_recovery",
      timestamp: now(),
      eventType: "startup_recovery_completed",
      mode: recoveryMode,
      reason,
      recoverableRunCount: recoverableRuns.runs?.length ?? 0,
      recoveredCount: recovered.length,
      manualRecoveryCount: manualRecoveredCount,
      skippedCount,
      autoReplayAttemptCount: autoRecoveredCount + failedCount,
      autoReplaySuccessCount: autoRecoveredCount,
      autoReplayFailureCount: failedCount,
    });

    return {
      autoRecoveredCount,
      failedCount,
      manualRecoveredCount,
      mode: recoveryMode,
      recoveredCount: recovered.length,
      skippedCount,
      runs: recovered,
    };
  },
});
