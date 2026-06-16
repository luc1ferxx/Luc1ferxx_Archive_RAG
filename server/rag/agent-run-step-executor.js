import { AGENT_RUN_STEP_KINDS } from "./agent-run-steps.js";
import {
  buildCapabilityResumeResponse,
  createDefaultAgentRunStepHandlerRegistry,
  getCapabilityResultCitations,
  getCapabilityResultText,
} from "./agent-run-step-handlers.js";

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
  executeDocumentRagStep,
  stepHandlerRegistry = createDefaultAgentRunStepHandlerRegistry({
    executeDocumentRagStep,
  }),
} = {}) => {
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

      return executeStep({
        accessScope,
        gate: retryContext.gate,
        run: queuedRun,
        step: retryStep,
      });
    },
  };
};
