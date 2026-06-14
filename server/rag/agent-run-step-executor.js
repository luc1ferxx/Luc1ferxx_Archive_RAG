import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "./agent-run-steps.js";
import { CAPABILITY_IDS } from "./capabilities/index.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeAction = (action) => normalizeText(action).toLowerCase();

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

export const getCapabilityResultText = (result = {}, gate = {}) =>
  normalizeText(result.text) ||
  normalizeText(result.value?.text) ||
  `${gate.capabilityLabel ?? gate.capabilityId ?? "Capability"} completed.`;

export const getCapabilityResultCitations = (result = {}) =>
  Array.isArray(result.citations)
    ? result.citations
    : Array.isArray(result.value?.citations)
      ? result.value.citations
      : [];

const toTraceStatus = (status) => (status === "paused" ? "needs_input" : status);

export const buildCapabilityResumeResponse = ({
  capabilityResult,
  gate,
  run,
} = {}) => {
  const answer = getCapabilityResultText(capabilityResult, gate);
  const citations = getCapabilityResultCitations(capabilityResult);
  const agentMode =
    gate?.capabilityId === CAPABILITY_IDS.webSearch ? "web" : "capability";
  const steps = run?.steps ?? [];
  const agentTrace = steps.map((step) => ({
    id: step.traceStepId || step.id,
    type: step.type,
    label: step.label,
    status: toTraceStatus(step.status),
    summary: step.summary,
    detail: {
      ...(step.detail ?? {}),
      attempt: step.attempt,
      kind: step.kind,
      retryOfStepId: step.retryOfStepId || null,
    },
  }));

  return {
    agentAnswer: answer,
    agentMode,
    agentRunId: run?.runId ?? null,
    agentRunStatus: run?.status ?? null,
    agentRunSteps: steps,
    agentSkills: [],
    agentTrace,
    agentObservability: {
      agentMode,
      approvalGates: run?.approvalGates ?? [],
      steps,
    },
    agentWorkingMemory: {},
    approvalGates: run?.approvalGates ?? [],
    clarification: {
      needed: false,
      reason: null,
      question: null,
      detail: null,
    },
    errors: {
      mcp: null,
      rag: null,
    },
    mcpAnswer: agentMode === "web" ? answer : "Web search not used.",
    ragAbstained: false,
    ragAnswer: answer,
    ragEvidenceSummary: null,
    ragGapPlan: null,
    ragMemoryApplied: false,
    ragResolvedQuestion: run?.goal ?? "",
    ragSources: citations,
    researchBrief: null,
  };
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
} = {}) => {
  const executeCapabilityStep = async ({
    accessScope = {},
    gate,
    run,
    step,
  } = {}) => {
    if (!capabilityRegistry?.execute) {
      fail("Capability registry is not available.", 500);
    }

    if (!gate?.capabilityId) {
      fail("Approved capability gate is missing capabilityId.");
    }

    if (!step?.id) {
      fail("Approved capability gate is missing a resumable step.");
    }

    await agentRunService.updateRunStep({
      accessScope,
      eventType: "step_started",
      runId: run.runId,
      status: AGENT_RUN_STEP_STATUSES.running,
      stepId: step.id,
    });

    let capabilityResult;

    try {
      capabilityResult = await capabilityRegistry.execute(gate.capabilityId, {
        accessScope,
        approval: {
          approved: true,
          decision: "approved",
          gateId: gate.id,
          source: "agent_run_action",
        },
        input: gate.inputPreview ?? {},
      });
    } catch (error) {
      await agentRunService.updateRunStep({
        accessScope,
        eventType: "step_failed",
        patch: {
          error: {
            message: serializeError(error, "Capability execution failed."),
            name: error.name ?? "Error",
          },
        },
        runId: run.runId,
        status: AGENT_RUN_STEP_STATUSES.failed,
        stepId: step.id,
      });
      throw error;
    }

    const runAfterStep = await agentRunService.updateRunStep({
      accessScope,
      eventType: "step_completed",
      patch: {
        output: {
          citationCount: getCapabilityResultCitations(capabilityResult).length,
          text: getCapabilityResultText(capabilityResult, gate),
        },
      },
      runId: run.runId,
      status: AGENT_RUN_STEP_STATUSES.completed,
      stepId: step.id,
    });
    const responseBody = buildCapabilityResumeResponse({
      capabilityResult,
      gate,
      run: runAfterStep,
    });
    const completedRun = await agentRunService.completeRun({
      accessScope,
      approvalGates: runAfterStep.approvalGates ?? [],
      decisions: runAfterStep.decisions ?? [],
      observations: [
        ...(runAfterStep.observations ?? []),
        {
          capabilityId: gate.capabilityId,
          status: AGENT_RUN_STEP_STATUSES.completed,
          stepId: step.id,
        },
      ],
      result: {
        agentMode: responseBody.agentMode,
        answer: responseBody.agentAnswer,
        citationCount: responseBody.ragSources?.length ?? 0,
        ragAbstained: Boolean(responseBody.ragAbstained),
        status: 200,
      },
      runId: run.runId,
      status: AGENT_RUN_STATUSES.completed,
      steps: runAfterStep.steps ?? [],
    });

    return {
      response: {
        ...responseBody,
        agentRunStatus: completedRun.status,
        agentRunSteps: completedRun.steps ?? [],
      },
      run: completedRun,
    };
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

      return executeCapabilityStep({
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

      if (originalStep.kind !== AGENT_RUN_STEP_KINDS.capabilityCall) {
        fail("Only capability_call steps can be retried by this executor.");
      }

      const gate = (existingRun.approvalGates ?? []).find(
        (approvalGate) =>
          approvalGate.id === originalStep.approvalGateId &&
          approvalGate.status === "approved"
      );

      if (!gate) {
        fail("Retry requires an approved capability gate.");
      }

      const queuedRun = await agentRunService.retryStep({
        accessScope,
        runId,
        stepId,
      });
      const retryStep = (queuedRun.steps ?? [])
        .filter((step) => step.retryOfStepId === stepId)
        .at(-1);

      return executeCapabilityStep({
        accessScope,
        gate,
        run: queuedRun,
        step: retryStep,
      });
    },
  };
};
