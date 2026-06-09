import { SKILL_CHAIN_MODE } from "./agent-planner.js";

export const serializeAgentError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

export const buildEvidenceClarification = ({ reason, check, gaps = [] } = {}) => ({
  reason,
  summary:
    "The agent could not verify the answer from the selected document evidence.",
  question:
    "I could not verify the answer from the selected documents. Which specific section, term, date, or document should I focus on?",
  detail: {
    reasons: check?.reasons ?? [],
    gaps,
  },
});

export const buildClarificationResponse = ({
  clarification,
  agentMode = "clarification",
  trace,
  agentSkills,
  agentObservability,
  workingMemory,
  question,
} = {}) => ({
  status: 200,
  body: {
    agentAnswer: clarification.question,
    agentMode,
    agentTrace: trace,
    agentSkills,
    agentObservability,
    agentWorkingMemory: workingMemory,
    researchBrief: null,
    ragAnswer: clarification.question,
    ragSources: [],
    ragResolvedQuestion: question,
    ragMemoryApplied: false,
    ragAbstained: true,
    ragAbstainReason: clarification.summary,
    ragGapPlan: null,
    ragEvidenceSummary: null,
    mcpAnswer: "Web search not used: clarification needed.",
    clarification: {
      needed: true,
      reason: clarification.reason,
      question: clarification.question,
      detail: clarification.detail ?? null,
    },
    errors: {
      rag: null,
      mcp: null,
    },
  },
});

export const buildAgentResponse = ({
  agentMode,
  baseAgentAnswer,
  directAnswerModes = new Set(),
  finalizer,
  plan,
  primaryCustomResult,
  question,
  ragResult,
  ragSources,
  researchBrief,
  shouldRunWeb,
  skippedWebBecauseBudget,
  trace,
  agentSkills,
  agentObservability,
  workingMemory,
  webResult,
} = {}) => {
  const agentAnswer = finalizer?.text ?? baseAgentAnswer;
  const ragError = ragResult?.ok === false
    ? serializeAgentError(ragResult.error, "Unable to answer from the document.")
    : null;
  const webError = webResult?.ok === false
    ? serializeAgentError(webResult.error, "Unable to answer from web search.")
    : null;
  const rawRagAnswer = researchBrief
    ? researchBrief.text
    : ragResult?.ok
    ? ragResult.value.text
    : agentMode === SKILL_CHAIN_MODE
      ? baseAgentAnswer
    : primaryCustomResult?.text
      ? primaryCustomResult.text
    : ragError
      ? `RAG unavailable: ${ragError}`
      : "";
  const ragAnswer =
    finalizer &&
    (agentMode === "document" ||
      agentMode === SKILL_CHAIN_MODE ||
      (primaryCustomResult && agentMode === primaryCustomResult.skillId))
      ? agentAnswer
      : rawRagAnswer;
  const rawRagAbstained = researchBrief
    ? researchBrief.findings.some((finding) => finding.abstained)
    : ragResult?.ok
      ? Boolean(ragResult.value.abstained)
      : primaryCustomResult
        ? Boolean(primaryCustomResult.abstained)
        : null;
  const ragAbstained = finalizer?.abstained ? true : rawRagAbstained;
  const status =
    !directAnswerModes.has(plan.mode) &&
    !ragResult?.ok &&
    (shouldRunWeb ? !webResult?.ok : true)
      ? 502
      : 200;

  return {
    status,
    body: {
      agentAnswer,
      agentMode,
      agentTrace: trace,
      agentSkills,
      agentObservability,
      agentWorkingMemory: workingMemory,
      researchBrief,
      ragAnswer,
      ragSources,
      ragResolvedQuestion: ragResult?.ok ? ragResult.value.resolvedQuery ?? question : question,
      ragMemoryApplied: ragResult?.ok ? Boolean(ragResult.value.memoryApplied) : false,
      ragAbstained,
      ragAbstainReason: ragResult?.ok
        ? ragResult.value.abstainReason ?? null
        : null,
      ragGapPlan: ragResult?.ok ? ragResult.value.gapPlan ?? null : null,
      ragEvidenceSummary: ragResult?.ok
        ? ragResult.value.evidenceSummary ?? null
        : null,
      mcpAnswer: webResult?.ok
        ? webResult.value.text
        : webResult?.ok === false
          ? `Web search unavailable: ${webError}`
          : skippedWebBecauseBudget
            ? "Web search not used: agent budget exhausted."
          : directAnswerModes.has(plan.mode)
            ? "Web search not used for this direct agent skill."
            : "Web search not used: document evidence was sufficient.",
      errors: {
        rag: ragError,
        mcp: webError,
      },
    },
  };
};
