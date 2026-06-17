import { AGENT_RUN_STEP_KINDS, AGENT_RUN_STEP_STATUSES } from "../agent-run-steps.js";
import { CAPABILITY_IDS } from "../capabilities/index.js";
import { runRetriableStep } from "./retriable-step-runner.js";
import {
  buildAgentTraceFromRunSteps,
  buildErrorPayload,
  fail,
  getStepInput,
  getStepType,
  normalizeRecord,
  normalizeText,
} from "./shared.js";

const getCapabilityAgentMode = (capabilityId, fallback = "capability") => {
  if (capabilityId === CAPABILITY_IDS.webSearch) {
    return "web";
  }

  if (capabilityId === CAPABILITY_IDS.arxivImportTopic) {
    return "arxiv_import";
  }

  if (capabilityId === CAPABILITY_IDS.documentDiscovery) {
    return "document_discovery";
  }

  return fallback;
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

export const buildCapabilityResumeResponse = ({
  capabilityId,
  capabilityResult,
  gate,
  run,
  step,
} = {}) => {
  const effectiveCapabilityId =
    capabilityId || gate?.capabilityId || step?.capabilityId;
  const answer = getCapabilityResultText(capabilityResult, {
    capabilityId: effectiveCapabilityId,
    capabilityLabel: gate?.capabilityLabel ?? step?.label,
  });
  const citations = getCapabilityResultCitations(capabilityResult);
  const agentMode = getCapabilityAgentMode(effectiveCapabilityId);
  const steps = run?.steps ?? [];
  const agentTrace = buildAgentTraceFromRunSteps(steps);

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
    ragAbstained: Boolean(
      capabilityResult.abstained ?? capabilityResult.value?.abstained
    ),
    ragAnswer: answer,
    ragEvidenceSummary: null,
    ragGapPlan: null,
    ragMemoryApplied: false,
    ragResolvedQuestion: run?.goal ?? "",
    ragSources: citations,
    researchBrief: null,
  };
};

const getWebSearchInput = ({ run = {}, step = {} } = {}) => {
  const stepInput = getStepInput(step);

  if (stepInput?.question) {
    return stepInput;
  }

  const detail = normalizeRecord(step.detail, {});
  const question =
    normalizeText(detail.question) ||
    normalizeText(detail.query) ||
    normalizeText(run.goal);

  return question ? { question } : null;
};

const getArxivImportInput = ({ step = {} } = {}) => {
  const stepInput = getStepInput(step);

  if (stepInput?.topic) {
    return stepInput;
  }

  const detail = normalizeRecord(step.detail, {});
  const topic = normalizeText(detail.topic);

  return topic
    ? {
        maxResults: detail.requestedMaxResults,
        topic,
      }
    : null;
};

const executeCapabilityBackedStep = async ({
  accessScope = {},
  agentRunService,
  approval = {},
  capabilityId,
  capabilityRegistry,
  gate = {},
  input = {},
  run,
  step,
} = {}) => {
  if (!capabilityRegistry?.execute) {
    fail("Capability registry is not available.", 500);
  }

  if (!capabilityId) {
    fail("Agent run step is missing capabilityId.");
  }

  if (!step?.id) {
    fail("Agent run step is missing a resumable step id.");
  }

  return runRetriableStep({
    accessScope,
    agentMode: getCapabilityAgentMode(capabilityId),
    agentRunService,
    buildCompletedPatch: ({ result }) => ({
      output: {
        citationCount: getCapabilityResultCitations(result).length,
        text: getCapabilityResultText(result, {
          capabilityId,
          capabilityLabel: gate?.capabilityLabel ?? step.label,
        }),
      },
    }),
    buildFailedPatch: ({ error }) => ({
      error: buildErrorPayload(error, "Capability execution failed."),
    }),
    buildObservation: () => ({
      capabilityId,
      status: AGENT_RUN_STEP_STATUSES.completed,
      stepId: step.id,
    }),
    buildResponse: ({ result, run: runAfterStep }) =>
      buildCapabilityResumeResponse({
        capabilityId,
        capabilityResult: result,
        gate,
        run: runAfterStep,
        step,
      }),
    execute: () =>
      capabilityRegistry.execute(capabilityId, {
        accessScope,
        approval,
        input,
      }),
    failureMessage: "Capability execution failed.",
    getCitations: getCapabilityResultCitations,
    input,
    run,
    step,
  });
};

export const createCapabilityCallStepHandler = () => ({
  id: "capability_call",
  label: "Capability Call",
  canHandle: ({ step } = {}) =>
    step?.kind === AGENT_RUN_STEP_KINDS.capabilityCall ||
    getStepType(step) === "capability_call",
  prepareRetry({ run = {}, step = {} } = {}) {
    const gate = (run.approvalGates ?? []).find(
      (approvalGate) =>
        approvalGate.id === step.approvalGateId &&
        approvalGate.status === "approved"
    );

    if (!gate) {
      fail("Retry requires an approved capability gate.");
    }

    return {
      gate,
    };
  },
  async execute({
    accessScope = {},
    agentRunService,
    capabilityRegistry,
    gate,
    run,
    step,
  } = {}) {
    if (!gate?.capabilityId) {
      fail("Approved capability gate is missing capabilityId.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        decision: "approved",
        gateId: gate.id,
        source: "agent_run_action",
      },
      capabilityId: gate.capabilityId,
      capabilityRegistry,
      gate,
      input: getStepInput(step) ?? gate.inputPreview ?? {},
      run,
      step,
    });
  },
});

export const createWebSearchStepHandler = () => ({
  id: "web_search",
  label: "Web Search",
  canHandle: ({ step } = {}) => getStepType(step) === "web_search",
  prepareRetry({ run = {}, step = {} } = {}) {
    const input = getWebSearchInput({
      run,
      step,
    });

    if (!input?.question) {
      fail("web_search retry requires a question input.");
    }

    return {
      input,
    };
  },
  async execute({
    accessScope = {},
    agentRunService,
    capabilityRegistry,
    run,
    step,
  } = {}) {
    const input = getWebSearchInput({
      run,
      step,
    });

    if (!input?.question) {
      fail("web_search retry requires a question input.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_step_retry",
      },
      capabilityId: CAPABILITY_IDS.webSearch,
      capabilityRegistry,
      input,
      run,
      step,
    });
  },
});

export const createArxivImportStepHandler = () => ({
  id: "arxiv_import",
  label: "arXiv Import",
  canHandle: ({ step } = {}) => getStepType(step) === "arxiv_import",
  prepareRetry({ step = {} } = {}) {
    const input = getArxivImportInput({
      step,
    });

    if (!input?.topic) {
      fail("arxiv_import retry requires a sanitized topic input.");
    }

    return {
      input,
    };
  },
  async execute({
    accessScope = {},
    agentRunService,
    capabilityRegistry,
    run,
    step,
  } = {}) {
    const input = getArxivImportInput({
      step,
    });

    if (!input?.topic) {
      fail("arxiv_import retry requires a sanitized topic input.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_step_retry",
      },
      capabilityId: CAPABILITY_IDS.arxivImportTopic,
      capabilityRegistry,
      input,
      run,
      step,
    });
  },
});
