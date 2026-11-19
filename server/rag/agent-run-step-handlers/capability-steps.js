import { AGENT_RUN_STEP_KINDS, AGENT_RUN_STEP_STATUSES } from "../agent-run-steps.js";
import { CAPABILITY_IDS } from "../capabilities/index.js";
import { buildCapabilityArtifactIdempotencyKey } from "../capabilities/artifacts.js";
import { formatCapabilityAnswer } from "./capability-answers.js";
import { runRetriableStep } from "./retriable-step-runner.js";
import {
  buildAgentTraceFromRunSteps,
  buildErrorPayload,
  fail,
  getStepType,
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

const getRootStepId = ({ run = {}, step = {} } = {}) => {
  const stepsById = new Map(
    (Array.isArray(run.steps) ? run.steps : []).map((entry) => [entry.id, entry])
  );
  const seen = new Set([step.id]);
  let rootStepId = step.id;
  let currentStep = step;

  while (currentStep?.retryOfStepId) {
    const parentStepId = currentStep.retryOfStepId;

    if (seen.has(parentStepId)) {
      break;
    }

    seen.add(parentStepId);
    rootStepId = parentStepId;
    currentStep = stepsById.get(parentStepId);
  }

  return rootStepId;
};

const getCapabilityResultText = (result = {}, gate = {}) =>
  normalizeText(result.text) ||
  normalizeText(result.value?.text) ||
  `${gate.capabilityLabel ?? gate.capabilityId ?? "Capability"} completed.`;

const getCapabilityResultCitations = (result = {}) =>
  Array.isArray(result.citations)
    ? result.citations
    : Array.isArray(result.value?.citations)
      ? result.value.citations
      : [];

/**
 * What an approved Capability answers with: { text, citations, abstained }.
 * arXiv import and document discovery return data and answer as their Skills
 * answered (capability-answers.js; `question` is the run's goal and `input`
 * the approved execution input); every other Capability answers with its
 * result's text and citations, or "<label> completed." when it has no text.
 */
export const buildCapabilityAnswer = ({
  capabilityId,
  capabilityLabel,
  input,
  question,
  result = {},
} = {}) =>
  formatCapabilityAnswer({ capabilityId, input, question, result }) ?? {
    abstained: Boolean(result.abstained ?? result.value?.abstained),
    citations: getCapabilityResultCitations(result),
    text: getCapabilityResultText(result, { capabilityId, capabilityLabel }),
  };

export const buildCapabilityResumeResponse = ({
  capabilityId,
  capabilityResult,
  gate,
  input,
  run,
  step,
} = {}) => {
  const effectiveCapabilityId =
    capabilityId || gate?.capabilityId || step?.capabilityId;
  const answer = buildCapabilityAnswer({
    capabilityId: effectiveCapabilityId,
    capabilityLabel: gate?.capabilityLabel ?? step?.label,
    input,
    question: run?.goal,
    result: capabilityResult,
  });
  const agentMode = getCapabilityAgentMode(effectiveCapabilityId);
  const steps = run?.steps ?? [];
  const agentTrace = buildAgentTraceFromRunSteps(steps);

  return {
    agentAnswer: answer.text,
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
    mcpAnswer: agentMode === "web" ? answer.text : "Web search not used.",
    ragAbstained: answer.abstained,
    ragAnswer: answer.text,
    ragEvidenceSummary: null,
    ragGapPlan: null,
    ragMemoryApplied: false,
    ragResolvedQuestion: run?.goal ?? "",
    ragSources: answer.citations,
    researchBrief: null,
  };
};

const rejectUnboundCapabilityRetry = () =>
  fail(
    "Approval-capable primary steps cannot be retried directly; retry the hash-bound capability_call step after approval."
  );

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

  const rootStepId = getRootStepId({
    run,
    step,
  });
  // The step's output, the run's result and the response all answer with the
  // same text and citations.
  const buildAnswer = (result) =>
    buildCapabilityAnswer({
      capabilityId,
      capabilityLabel: gate?.capabilityLabel ?? step.label,
      input,
      question: run.goal,
      result,
    });

  return runRetriableStep({
    accessScope,
    agentMode: getCapabilityAgentMode(capabilityId),
    agentRunService,
    buildCompletedPatch: ({ citations, result }) => ({
      output: {
        citationCount: citations.length,
        text: buildAnswer(result).text,
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
        input,
        run: runAfterStep,
        step,
      }),
    execute: () =>
      capabilityRegistry.execute(capabilityId, {
        accessScope,
        approval,
        input,
        services: {
          artifactExecution: {
            idempotencyKey: buildCapabilityArtifactIdempotencyKey({
              parts: [run.runId, rootStepId, capabilityId],
            }),
            sourceRunId: run.runId,
          },
        },
      }),
    getCitations: (result) => buildAnswer(result).citations,
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
    const stepApprovalObjectHash = normalizeText(
      step.detail?.approvalObjectHash
    );

    if (
      !gate ||
      !stepApprovalObjectHash ||
      stepApprovalObjectHash !== normalizeText(gate.approvalObjectHash)
    ) {
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

    if (
      typeof agentRunService?.getApprovedCapabilityExecution !== "function"
    ) {
      fail("Approval execution snapshot resolver is unavailable.");
    }

    const approvalObjectHash = normalizeText(
      step.detail?.approvalObjectHash
    );
    const execution = await agentRunService.getApprovedCapabilityExecution({
      accessScope,
      approvalObjectHash,
      gateId: step.approvalGateId,
      runId: run.runId,
    });

    if (
      execution.gate.id !== gate.id ||
      execution.capabilityId !== normalizeText(gate.capabilityId) ||
      execution.capabilityVersion !== normalizeText(gate.capabilityVersion) ||
      (normalizeText(step.capabilityId) &&
        normalizeText(step.capabilityId) !== execution.capabilityId) ||
      (normalizeText(step.capabilityVersion) &&
        normalizeText(step.capabilityVersion) !== execution.capabilityVersion)
    ) {
      fail("Approved capability execution binding does not match the step.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        approvalObjectHash: execution.approvalObjectHash,
        decision: "approved",
        gateId: execution.gate.id,
      },
      capabilityId: execution.capabilityId,
      capabilityRegistry,
      gate: execution.gate,
      input: execution.input,
      run,
      step,
    });
  },
});

export const createWebSearchStepHandler = () => ({
  id: "web_search",
  label: "Web Search",
  canHandle: ({ step } = {}) => getStepType(step) === "web_search",
  prepareRetry: rejectUnboundCapabilityRetry,
  execute: rejectUnboundCapabilityRetry,
});

export const createArxivImportStepHandler = () => ({
  id: "arxiv_import",
  label: "arXiv Import",
  canHandle: ({ step } = {}) => getStepType(step) === "arxiv_import",
  prepareRetry: rejectUnboundCapabilityRetry,
  execute: rejectUnboundCapabilityRetry,
});
