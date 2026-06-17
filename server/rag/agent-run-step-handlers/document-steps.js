import { AGENT_RUN_STEP_STATUSES } from "../agent-run-steps.js";
import { runRetriableStep } from "./retriable-step-runner.js";
import {
  buildAgentTraceFromRunSteps,
  buildErrorPayload,
  fail,
  getStepInput,
  getStepType,
  normalizeRecord,
  normalizeText,
  normalizeTextList,
  toArray,
} from "./shared.js";

const getDocumentRagInput = ({ run = {}, step = {} } = {}) => {
  const stepInput = normalizeRecord(getStepInput(step), {});
  const detail = normalizeRecord(step.detail, {});
  const runInput = normalizeRecord(run.input, {});
  const stepDocIds = normalizeTextList(stepInput.docIds);
  const runDocIds = normalizeTextList(runInput.docIds);
  const question =
    normalizeText(stepInput.question) ||
    normalizeText(detail.question) ||
    normalizeText(run.goal);
  const retrievalPlan =
    normalizeRecord(stepInput.retrievalPlan, null) ??
    normalizeRecord(detail.retrievalPlan, null) ??
    null;
  const sessionId =
    normalizeText(stepInput.sessionId) || normalizeText(runInput.sessionId);
  const userId =
    normalizeText(stepInput.userId) || normalizeText(runInput.userId);

  return {
    docIds: stepDocIds.length > 0 ? stepDocIds : runDocIds,
    question,
    retrievalPlan,
    sessionId: sessionId || null,
    userId: userId || null,
  };
};

const assertValidDocumentRagInput = (input = {}) => {
  if (!input.question) {
    fail("document_rag retry requires a question input.");
  }

  if (!toArray(input.docIds).length) {
    fail("document_rag retry requires at least one document id.");
  }
};

const getDocumentRagSkillVersion = (step = {}) =>
  normalizeText(step.detail?.skillVersion) || "unknown";

export const getDocumentRagResultText = (result = {}) =>
  normalizeText(result.text) || "Document RAG completed.";

export const getDocumentRagResultCitations = (result = {}) =>
  Array.isArray(result.citations) ? result.citations : [];

export const buildDocumentRagResumeResponse = ({
  documentResult = {},
  input = {},
  run,
  step,
} = {}) => {
  const answer = getDocumentRagResultText(documentResult);
  const citations = getDocumentRagResultCitations(documentResult);
  const agentMode = "document";
  const steps = run?.steps ?? [];
  const skillVersion = getDocumentRagSkillVersion(step);
  const skillObservation = {
    skillId: "document_rag",
    skillVersion,
    label: "Document RAG",
    selected: true,
    status: AGENT_RUN_STEP_STATUSES.completed,
    attempts: step?.attempt ?? 1,
    skippedCount: 0,
    retryCount: step?.retryOfStepId ? 1 : 0,
    followUpCount: 0,
    totalDurationMs: 0,
    citationCount: citations.length,
    lastCitationCount: citations.length,
    abstained: Boolean(documentResult.abstained),
    errorCount: 0,
    errors: [],
    budgetUsed: null,
    budgetLimit: null,
    budgetRemaining: null,
    budgetDelta: {},
  };

  return {
    agentAnswer: answer,
    agentMode,
    agentRunId: run?.runId ?? null,
    agentRunStatus: run?.status ?? null,
    agentRunSteps: steps,
    agentSkills: [
      {
        skillId: "document_rag",
        skillVersion,
        label: "Document RAG",
        status: AGENT_RUN_STEP_STATUSES.completed,
      },
    ],
    agentTrace: buildAgentTraceFromRunSteps(steps),
    agentObservability: {
      agentMode,
      approvalGates: run?.approvalGates ?? [],
      runs: [
        {
          skillId: "document_rag",
          skillVersion,
          label: "Document RAG",
          phase: step?.retryOfStepId ? "retry" : "primary",
          status: AGENT_RUN_STEP_STATUSES.completed,
          citationCount: citations.length,
          abstained: Boolean(documentResult.abstained),
          error: null,
        },
      ],
      selectedSkills: [
        {
          skillId: "document_rag",
          skillVersion,
          label: "Document RAG",
          budgetKey: "documentRagCalls",
        },
      ],
      skills: [skillObservation],
      steps,
      workingMemory: {},
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
    mcpAnswer: "Web search not used: document retry completed.",
    ragAbstained: Boolean(documentResult.abstained),
    ragAbstainReason: documentResult.abstainReason ?? null,
    ragAnswer: answer,
    ragEvidenceSummary: documentResult.evidenceSummary ?? null,
    ragGapPlan: documentResult.gapPlan ?? null,
    ragMemoryApplied: Boolean(documentResult.memoryApplied),
    ragResolvedQuestion:
      normalizeText(documentResult.resolvedQuery) ||
      normalizeText(input.question) ||
      normalizeText(run?.goal),
    ragSources: citations,
    researchBrief: null,
  };
};

export const createDocumentRagStepExecutor = ({ ragService } = {}) => async ({
  accessScope = {},
  agentRunService,
  run,
  step,
} = {}) => {
  if (!ragService?.chat) {
    fail("Document RAG service is not available.", 500);
  }

  if (!step?.id) {
    fail("Agent run step is missing a resumable step id.");
  }

  const input = getDocumentRagInput({
    run,
    step,
  });

  assertValidDocumentRagInput(input);

  return runRetriableStep({
    accessScope,
    agentMode: "document",
    agentRunService,
    buildCompletedPatch: ({ citations, input: stepInput, result }) => ({
      input: stepInput,
      output: {
        abstained: Boolean(result.abstained),
        citationCount: citations.length,
        text: getDocumentRagResultText(result),
      },
    }),
    buildFailedPatch: ({ error, input: stepInput }) => ({
      error: buildErrorPayload(error, "Document RAG execution failed."),
      input: stepInput,
    }),
    buildObservation: ({ citations }) => ({
      citationCount: citations.length,
      skillId: "document_rag",
      skillVersion: getDocumentRagSkillVersion(step),
      status: AGENT_RUN_STEP_STATUSES.completed,
      stepId: step.id,
    }),
    buildResponse: ({ input: stepInput, result, run: runAfterStep }) =>
      buildDocumentRagResumeResponse({
        documentResult: result,
        input: stepInput,
        run: runAfterStep,
        step,
      }),
    buildStartedPatch: ({ input: stepInput }) => ({
      input: stepInput,
    }),
    execute: async ({ input: stepInput }) =>
      ragService.chat(stepInput.docIds, stepInput.question, {
        accessScope,
        retrievalPlan: stepInput.retrievalPlan,
        sessionId: stepInput.sessionId,
        userId: stepInput.userId,
      }),
    failureMessage: "Document RAG execution failed.",
    getCitations: getDocumentRagResultCitations,
    input,
    run,
    step,
  });
};

const createDocumentBackedStepHandler = ({
  executeDocumentRagStep,
  id,
  label,
  stepType,
} = {}) => ({
  id,
  label,
  canHandle: ({ step } = {}) => getStepType(step) === stepType,
  prepareRetry({ run = {}, step = {} } = {}) {
    if (typeof executeDocumentRagStep !== "function") {
      fail(
        `${stepType} retry is not wired yet. Provide a document RAG step handler before retrying this step.`
      );
    }

    const retryCount = toArray(run.steps).filter(
      (runStep) => runStep.retryOfStepId === step.id
    ).length;

    if (retryCount >= 1) {
      fail(`${stepType} steps can only be retried once.`);
    }

    assertValidDocumentRagInput(
      getDocumentRagInput({
        run,
        step,
      })
    );

    return {};
  },
  async execute(context = {}) {
    if (typeof executeDocumentRagStep !== "function") {
      fail(
        `${stepType} retry is not wired yet. Provide a document RAG step handler before retrying this step.`
      );
    }

    return executeDocumentRagStep(context);
  },
});

export const createDocumentRagStepHandler = ({
  executeDocumentRagStep,
} = {}) =>
  createDocumentBackedStepHandler({
    executeDocumentRagStep,
    id: "document_rag",
    label: "Document RAG",
    stepType: "document_rag",
  });

export const createFollowUpRetrievalStepHandler = ({
  executeDocumentRagStep,
} = {}) =>
  createDocumentBackedStepHandler({
    executeDocumentRagStep,
    id: "follow_up_retrieval",
    label: "Follow-up Retrieval",
    stepType: "follow_up_retrieval",
  });
