import { AGENT_RUN_STEP_KINDS, AGENT_RUN_STEP_STATUSES } from "../agent-run-steps.js";
import { CAPABILITY_IDS } from "../capabilities/index.js";
import { buildCapabilityArtifactIdempotencyKey } from "../capabilities/artifacts.js";
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
        services: {
          artifactExecution: {
            idempotencyKey: buildCapabilityArtifactIdempotencyKey({
              parts: [run.runId, rootStepId, capabilityId],
            }),
            sourceRunId: run.runId,
          },
        },
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
        source: "agent_run_action",
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
