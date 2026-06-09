import { finalizeAgentAnswer } from "./agent-finalizer.js";
import {
  buildDirectAnswerModes,
  buildSynthesisAnswer,
  shouldFinalizeAgentAnswer,
} from "./agent-synthesis.js";
import { buildAgentResponse } from "./agent-response-builder.js";
import { buildFinalizerSummary } from "./agent-trace.js";

export const resolveAgentMode = ({ plan, ragResult, webResult } = {}) =>
  ragResult?.ok && ragResult.value.abstained && webResult?.ok
    ? "document_web"
    : plan.mode;

export const selectPrimaryCustomResult = (customSkillResults = []) =>
  customSkillResults.find((result) => result.ok);

export const selectRagSources = ({
  customSkillResults = [],
  ragResult,
  researchBrief,
} = {}) => {
  if (researchBrief) {
    return researchBrief.citations ?? [];
  }

  if (ragResult?.ok) {
    return ragResult.value.citations ?? [];
  }

  return customSkillResults
    .filter((result) => result.ok)
    .flatMap((result) => result.citations ?? []);
};

export const finalizeAgentRun = async ({
  addTraceStep,
  buildAgentObservability,
  customSkillResults = [],
  customSkills = [],
  discoveryAnswer,
  documentRagSkill,
  getAgentSkills,
  getBudgetSnapshot,
  inventoryAnswer,
  plan,
  question,
  ragResult,
  recordAgentTrace,
  recordWorkingMemoryClaimSupport,
  researchBrief,
  shouldRunWeb,
  skippedWebBecauseBudget,
  trace,
  webResult,
  workingMemory,
} = {}) => {
  const agentMode = resolveAgentMode({
    plan,
    ragResult,
    webResult,
  });
  const primaryCustomResult = selectPrimaryCustomResult(customSkillResults);
  const directAnswerModes = buildDirectAnswerModes({
    customSkills,
  });
  const ragSources = selectRagSources({
    customSkillResults,
    ragResult,
    researchBrief,
  });
  const baseAgentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: agentMode,
    },
    ragResult,
    webResult,
    customSkillResults,
    inventoryAnswer,
    discoveryAnswer,
    researchBrief,
  });
  const shouldFinalizeAnswer = shouldFinalizeAgentAnswer({
    agentMode,
    primaryCustomResult,
    ragSources,
  });

  addTraceStep({
    type: "synthesis",
    label: "Synthesis",
    summary: "Composed the final agent answer from completed tool results.",
    detail: {
      budget: getBudgetSnapshot(),
    },
  });

  const finalizer = shouldFinalizeAnswer
    ? finalizeAgentAnswer({
        answerText: baseAgentAnswer,
        citations: ragSources,
      })
    : null;

  if (finalizer) {
    recordWorkingMemoryClaimSupport({
      skill: primaryCustomResult ?? documentRagSkill ?? {
        id: "answer_finalizer",
        version: "1.0.0",
        label: "Answer Finalizer",
      },
      phase: "final",
      check: {
        claimSupport: finalizer.claimSupport,
      },
    });

    addTraceStep({
      type: "answer_finalizer",
      label: "Answer Finalizer",
      summary: buildFinalizerSummary(finalizer),
      detail: {
        changed: finalizer.changed,
        abstained: finalizer.abstained,
        removedClaims: finalizer.removedClaims,
        claimSupport: finalizer.claimSupport,
      },
    });
  }

  const agentObservability = buildAgentObservability({
    agentMode,
  });
  const agentSkills = getAgentSkills();
  const agentResponse = buildAgentResponse({
    agentMode,
    baseAgentAnswer,
    directAnswerModes,
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
  });

  await recordAgentTrace({
    agentMode,
    agentSkills,
    agentObservability,
    status: agentResponse.status,
  });

  return agentResponse;
};
