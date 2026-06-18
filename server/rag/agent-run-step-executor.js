import { AGENT_RUN_STEP_KINDS } from "./agent-run-steps.js";
import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  buildCapabilityResumeResponse,
  createDefaultAgentRunStepHandlerRegistry,
  getCapabilityResultCitations,
  getCapabilityResultText,
} from "./agent-run-step-handlers/index.js";
import { recordRagTrace } from "./observability.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeAction = (action) => normalizeText(action).toLowerCase();

export {
  buildCapabilityResumeResponse,
  getCapabilityResultCitations,
  getCapabilityResultText,
};

const findApprovalGate = ({ gateId = "", run } = {}) =>
  (run?.approvalGates ?? []).find(
    (gate) =>
      gate.status === "approved" &&
      (!gateId || gate.id === gateId || gate.stepId === gateId)
  );

const findApprovedGateForStep = ({ run, step } = {}) =>
  findApprovalGate({
    gateId: step?.approvalGateId,
    run,
  });

const findCapabilityStepForGate = ({ gate, run } = {}) =>
  (run?.steps ?? []).find(
    (step) =>
      step.kind === AGENT_RUN_STEP_KINDS.capabilityCall &&
      step.approvalGateId === gate?.id
  );

const findStep = ({ run, stepId } = {}) =>
  (run?.steps ?? []).find((step) => step.id === stepId);

const fail = (message, status = 409) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

export const createAgentRunStepExecutor = ({
  agentRunService,
  capabilityRegistry,
  executeCustomSkillStep,
  executeDocumentRagStep,
  executeResearchQuestionStep,
  now = () => new Date().toISOString(),
  recordStepReplayTrace = recordRagTrace,
  stepHandlerRegistry = createDefaultAgentRunStepHandlerRegistry({
    executeCustomSkillStep,
    executeDocumentRagStep,
    executeResearchQuestionStep,
  }),
} = {}) => {
  const recordReplayTrace = async ({
    action,
    error,
    result,
    run,
    step,
  } = {}) =>
    recordStepReplayTrace?.({
      traceType: "agent_run_step_replay",
      timestamp: now(),
      action,
      runId: run?.runId ?? null,
      runStatus: result?.run?.status ?? run?.status ?? null,
      stepId: step?.id ?? null,
      stepKind: step?.kind ?? null,
      stepType: step?.type ?? null,
      retryOfStepId: step?.retryOfStepId ?? null,
      status: error ? "failed" : "completed",
      error: error
        ? {
            message: error instanceof Error ? error.message : String(error),
            status: error?.status ?? 500,
          }
        : null,
    });

  const resolveStepHandler = ({ gate, run, step } = {}) => {
    const handler = stepHandlerRegistry.resolve?.({
      gate,
      run,
      step,
    });

    if (!handler) {
      fail(
        `Unsupported agent run step type: ${step?.type ?? step?.kind ?? "unknown"}.`
      );
    }

    return handler;
  };

  const executeStep = async ({
    accessScope = {},
    gate,
    run,
    step,
  } = {}) => {
    if (!step?.id) {
      fail("Agent run step not found.", 404);
    }

    const handler = resolveStepHandler({
      gate,
      run,
      step,
    });

    return handler.execute({
      accessScope,
      agentRunService,
      capabilityRegistry,
      gate,
      run,
      step,
    });
  };

  return {
    async resumeStep({ accessScope = {}, runId, stepId } = {}) {
      const existingRun = await agentRunService.getRun({
        accessScope,
        runId,
      });
      const step = findStep({
        run: existingRun,
        stepId,
      });

      if (!step) {
        fail("Agent run step not found.", 404);
      }

      const runningRun =
        existingRun.status === AGENT_RUN_STATUSES.running
          ? existingRun
          : await agentRunService.updateRun({
              accessScope,
              runId,
              patch: {
                status: AGENT_RUN_STATUSES.running,
              },
            });

      try {
        const result = await executeStep({
          accessScope,
          gate: findApprovedGateForStep({
            run: runningRun,
            step,
          }),
          run: runningRun,
          step,
        });

        await recordReplayTrace({
          action: "resume_step",
          result,
          run: runningRun,
          step,
        });

        return result;
      } catch (error) {
        await recordReplayTrace({
          action: "resume_step",
          error,
          run: runningRun,
          step,
        });
        throw error;
      }
    },

    async applyApprovalAction({
      accessScope = {},
      action,
      gateId = "",
      payload = {},
      runId,
    } = {}) {
      const normalizedAction = normalizeAction(action);
      const run = await agentRunService.applyApprovalAction({
        accessScope,
        action: normalizedAction,
        gateId,
        payload,
        runId,
      });

      if (normalizedAction === "deny") {
        return {
          run,
        };
      }

      const gate = findApprovalGate({
        gateId,
        run,
      });
      const step = findCapabilityStepForGate({
        gate,
        run,
      });

      return executeStep({
        accessScope,
        gate,
        run,
        step,
      });
    },

    async retryStep({ accessScope = {}, runId, stepId } = {}) {
      const existingRun = await agentRunService.getRun({
        accessScope,
        runId,
      });
      const originalStep = findStep({
        run: existingRun,
        stepId,
      });

      if (!originalStep) {
        fail("Agent run step not found.", 404);
      }

      const handler = resolveStepHandler({
        run: existingRun,
        step: originalStep,
      });
      const retryContext =
        (await handler.prepareRetry?.({
          accessScope,
          agentRunService,
          capabilityRegistry,
          run: existingRun,
          step: originalStep,
        })) ?? {};

      const queuedRun = await agentRunService.retryStep({
        accessScope,
        runId,
        stepId,
      });
      const retryStep = (queuedRun.steps ?? [])
        .filter((step) => step.retryOfStepId === stepId)
        .at(-1);

      try {
        const result = await executeStep({
          accessScope,
          gate: retryContext.gate,
          run: queuedRun,
          step: retryStep,
        });

        await recordReplayTrace({
          action: "retry_step",
          result,
          run: queuedRun,
          step: retryStep,
        });

        return result;
      } catch (error) {
        await recordReplayTrace({
          action: "retry_step",
          error,
          run: queuedRun,
          step: retryStep,
        });
        throw error;
      }
    },
  };
};
