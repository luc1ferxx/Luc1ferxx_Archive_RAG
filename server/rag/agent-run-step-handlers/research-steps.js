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

// The retry of one research question (a research brief's sub-question), run by
// an operator after the step failed. There is no handler for a `custom_skill`
// step here any more: a custom Skill runs only as a node of its execution
// graph.

const getResearchQuestionInput = ({ run = {}, step = {} } = {}) => {
  const stepInput = normalizeRecord(getStepInput(step), {});
  const detail = normalizeRecord(step.detail, {});
  const runInput = normalizeRecord(run.input, {});
  const stepDocIds = normalizeTextList(stepInput.docIds);
  const runDocIds = normalizeTextList(runInput.docIds);
  const question =
    normalizeText(stepInput.question) ||
    normalizeText(detail.question) ||
    normalizeText(step.summary) ||
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
    researchQuestionId:
      normalizeText(stepInput.researchQuestionId) ||
      normalizeText(stepInput.id) ||
      normalizeText(detail.researchQuestionId) ||
      normalizeText(detail.id) ||
      step.id,
    retrievalPlan,
    sessionId: sessionId || null,
    userId: userId || null,
  };
};

const assertValidResearchQuestionInput = (input = {}) => {
  if (!input.question) {
    fail("research_question retry requires a question input.");
  }

  if (!toArray(input.docIds).length) {
    fail("research_question retry requires at least one document id.");
  }
};

const getResearchQuestionSkillVersion = (step = {}) =>
  normalizeText(step.detail?.skillVersion) ||
  normalizeText(step.input?.skillVersion) ||
  "1.0.0";

const getSkillResultText = (result = {}, fallback = "Skill completed.") =>
  normalizeText(result.text) ||
  normalizeText(result.value?.text) ||
  normalizeText(result.answer) ||
  fallback;

const getSkillResultCitations = (result = {}) =>
  Array.isArray(result.citations)
    ? result.citations
    : Array.isArray(result.value?.citations)
      ? result.value.citations
      : [];

const buildSkillResumeResponse = ({
  agentMode,
  input = {},
  mcpAnswer,
  researchBrief = null,
  run,
  skill = {},
  skillResult = {},
  step,
} = {}) => {
  const answer = getSkillResultText(
    skillResult,
    `${skill.label ?? "Skill"} completed.`
  );
  const citations = getSkillResultCitations(skillResult);
  const skillId = skill.id ?? input.skillId ?? agentMode;
  const skillVersion =
    skill.version ?? input.skillVersion ?? getResearchQuestionSkillVersion(step);
  const label = skill.label ?? step?.label ?? skillId;
  const steps = run?.steps ?? [];
  const skillObservation = {
    skillId,
    skillVersion,
    label,
    selected: true,
    status: AGENT_RUN_STEP_STATUSES.completed,
    attempts: step?.attempt ?? 1,
    skippedCount: 0,
    retryCount: step?.retryOfStepId ? 1 : 0,
    followUpCount: 0,
    totalDurationMs: 0,
    citationCount: citations.length,
    lastCitationCount: citations.length,
    abstained: Boolean(skillResult.abstained ?? skillResult.value?.abstained),
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
        skillId,
        skillVersion,
        label,
        status: AGENT_RUN_STEP_STATUSES.completed,
      },
    ],
    agentTrace: buildAgentTraceFromRunSteps(steps),
    agentObservability: {
      agentMode,
      approvalGates: run?.approvalGates ?? [],
      runs: [
        {
          skillId,
          skillVersion,
          label,
          phase: step?.retryOfStepId ? "retry" : "primary",
          status: AGENT_RUN_STEP_STATUSES.completed,
          citationCount: citations.length,
          abstained: Boolean(
            skillResult.abstained ?? skillResult.value?.abstained
          ),
          error: null,
        },
      ],
      selectedSkills: [
        {
          skillId,
          skillVersion,
          label,
          budgetKey: skill.budgetKey ?? null,
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
    mcpAnswer: mcpAnswer ?? "Web search not used: skill retry completed.",
    ragAbstained: Boolean(skillResult.abstained ?? skillResult.value?.abstained),
    ragAbstainReason:
      skillResult.abstainReason ?? skillResult.value?.abstainReason ?? null,
    ragAnswer: answer,
    ragEvidenceSummary: skillResult.evidenceSummary ?? null,
    ragGapPlan: skillResult.gapPlan ?? null,
    ragMemoryApplied: Boolean(skillResult.memoryApplied),
    ragResolvedQuestion:
      normalizeText(skillResult.resolvedQuery) ||
      normalizeText(skillResult.value?.resolvedQuery) ||
      normalizeText(input.question) ||
      normalizeText(run?.goal),
    ragSources: citations,
    researchBrief,
  };
};

const buildResearchQuestionBrief = ({
  input = {},
  result = {},
  run = {},
} = {}) => ({
  citations: getSkillResultCitations(result),
  findings: [
    {
      id: input.researchQuestionId,
      question: input.question,
      status: AGENT_RUN_STEP_STATUSES.completed,
      text: getSkillResultText(result, "Research question completed."),
      citations: getSkillResultCitations(result),
      abstained: Boolean(result.abstained),
      abstainReason: result.abstainReason ?? null,
      resolvedQuery: result.resolvedQuery ?? input.question,
    },
  ],
  questions: [
    {
      id: input.researchQuestionId,
      question: input.question,
      status: AGENT_RUN_STEP_STATUSES.completed,
    },
  ],
  text: getSkillResultText(result, "Research question completed."),
  topic: normalizeText(run.goal) || input.question,
});

export const createResearchQuestionStepExecutor = ({ ragService } = {}) => async ({
  accessScope = {},
  agentRunService,
  run,
  step,
} = {}) => {
  if (!ragService?.chat) {
    fail("Research question retry requires a RAG service.", 500);
  }

  if (!step?.id) {
    fail("Agent run step is missing a resumable step id.");
  }

  const input = getResearchQuestionInput({
    run,
    step,
  });
  assertValidResearchQuestionInput(input);

  const skill = {
    budgetKey: "researchQuestions",
    id: "research_brief",
    label: "Research Brief",
    version: getResearchQuestionSkillVersion(step),
  };

  return runRetriableStep({
    accessScope,
    agentMode: "research_brief",
    agentRunService,
    buildCompletedPatch: ({ citations, input: stepInput, result }) => ({
      input: stepInput,
      output: {
        abstained: Boolean(result.abstained),
        citationCount: citations.length,
        text: getSkillResultText(result, "Research question completed."),
      },
    }),
    buildFailedPatch: ({ error, input: stepInput }) => ({
      error: buildErrorPayload(error, "Research question execution failed."),
      input: stepInput,
    }),
    buildObservation: ({ citations }) => ({
      citationCount: citations.length,
      skillId: skill.id,
      skillVersion: skill.version,
      status: AGENT_RUN_STEP_STATUSES.completed,
      stepId: step.id,
    }),
    buildResponse: ({ input: stepInput, result, run: runAfterStep }) =>
      buildSkillResumeResponse({
        agentMode: "research_brief",
        input: stepInput,
        mcpAnswer: "Web search not used: research question retry completed.",
        researchBrief: buildResearchQuestionBrief({
          input: stepInput,
          result,
          run,
        }),
        run: runAfterStep,
        skill,
        skillResult: result,
        step,
      }),
    buildStartedPatch: ({ input: stepInput }) => ({
      input: stepInput,
    }),
    execute: async ({ input: stepInput }) =>
      ragService.chat(stepInput.docIds, stepInput.question, {
        accessScope,
        includeRetrievedContexts: true,
        // A research question is text the brief composed: it never writes
        // conversation memory, on the first run or on a retry.
        memoryWrites: false,
        retrievalPlan: stepInput.retrievalPlan,
        sessionId: stepInput.sessionId,
        userId: stepInput.userId,
      }),
    getCitations: getSkillResultCitations,
    input,
    run,
    step,
  });
};

export const createResearchQuestionStepHandler = ({
  executeResearchQuestionStep,
} = {}) => ({
  id: "research_question",
  label: "Research Question",
  canHandle: ({ step } = {}) => getStepType(step) === "research_question",
  prepareRetry({ run = {}, step = {} } = {}) {
    if (typeof executeResearchQuestionStep !== "function") {
      fail(
        "research_question retry is not wired yet. Provide a research question step handler before retrying this step."
      );
    }

    assertValidResearchQuestionInput(
      getResearchQuestionInput({
        run,
        step,
      })
    );

    return {};
  },
  async execute(context = {}) {
    if (typeof executeResearchQuestionStep !== "function") {
      fail(
        "research_question retry is not wired yet. Provide a research question step handler before retrying this step."
      );
    }

    return executeResearchQuestionStep(context);
  },
});
