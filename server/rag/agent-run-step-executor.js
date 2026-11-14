import { AGENT_RUN_STEP_KINDS } from "./agent-run-steps.js";
import { EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY } from "./agent-execution-graph-checkpoint.js";
import { assertStandaloneGraphReplayAllowed } from "./agent-run-graph-replay-guard.js";
import {
  isRemovedUnifiedGraphApprovalPause,
  refuseRemovedUnifiedGraphRun,
} from "./agent-removed-unified-graph.js";
import {
  buildCapabilityResumeResponse,
  createDefaultAgentRunStepHandlerRegistry,
  getCapabilityResultCitations,
  getCapabilityResultText,
} from "./agent-run-step-handlers/index.js";
import { recordRagTrace } from "./observability.js";
import { normalizeText } from "../lib/normalize-text.js";

const normalizeAction = (action) => normalizeText(action).toLowerCase();

export {
  buildCapabilityResumeResponse,
  getCapabilityResultCitations,
  getCapabilityResultText,
};

const findApprovalGate = ({ gateId = "", run } = {}) => {
  const normalizedGateId = normalizeText(gateId);

  return (run?.approvalGates ?? []).find(
    (gate) =>
      gate.status === "approved" &&
      (!normalizedGateId ||
        normalizeText(gate.id) === normalizedGateId ||
        normalizeText(gate.stepId) === normalizedGateId)
  );
};

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

// Public run projections omit the checkpoint. Combine that projection with the
// private checkpoint for the same pure guard used inside run-store CAS updates.
const assertStandaloneReplayAllowed = async ({
  accessScope,
  agentRunService,
  gateId = "",
  run,
  runId,
  step,
} = {}) => {
  const loaded = await agentRunService.getExecutionGraphCheckpoint?.({ accessScope, runId });
  const checkpoint = loaded?.checkpoint;
  assertStandaloneGraphReplayAllowed({
    gateId,
    run: checkpoint
      ? {
          ...run,
          result: {
            ...run?.result,
            [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: checkpoint,
          },
        }
      : run,
    stepId: step?.id,
  });
};

// Runs one persisted step outside a request: the capability step an approval
// queued, and a failed step an operator retries. It never runs a custom Skill
// (a custom Skill runs only as a node of its execution graph, and the replay
// guard refuses its step) and it never resumes an interrupted step; an
// interrupted graph is continued as a whole by startup recovery.
export const createAgentRunStepExecutor = ({
  agentRunService,
  capabilityRegistry,
  executeDocumentRagStep,
  executeResearchQuestionStep,
  now = () => new Date().toISOString(),
  recordStepReplayTrace = recordRagTrace,
  stepHandlerRegistry = createDefaultAgentRunStepHandlerRegistry({
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
    async applyApprovalAction({
      accessScope = {},
      action,
      gateId = "",
      payload = {},
      runId,
    } = {}) {
      const normalizedAction = normalizeAction(action);
      const normalizedGateId = normalizeText(gateId) || normalizeText(payload?.gateId);
      const loadedGraph = await agentRunService.getExecutionGraphCheckpoint?.({
        accessScope,
        runId,
      });

      // A run of the removed v3 unified graph parked at its approval gate:
      // its gate can no longer be decided. Neither an approval nor a denial
      // is recorded.
      if (isRemovedUnifiedGraphApprovalPause(loadedGraph?.checkpoint)) {
        await refuseRemovedUnifiedGraphRun({ accessScope, agentRunService, runId });
      }

      const existingRun = await agentRunService.getRun({ accessScope, runId });

      await assertStandaloneReplayAllowed({
        accessScope,
        agentRunService,
        gateId: normalizedGateId,
        run: existingRun,
        runId,
      });

      const run = await agentRunService.applyApprovalAction({
        accessScope,
        action: normalizedAction,
        gateId: normalizedGateId,
        payload,
        runId,
      });

      if (normalizedAction === "deny") {
        return {
          run,
        };
      }

      const gate = findApprovalGate({
        gateId: normalizedGateId,
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

      await assertStandaloneReplayAllowed({
        accessScope,
        agentRunService,
        run: existingRun,
        runId,
        step: originalStep,
      });

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
