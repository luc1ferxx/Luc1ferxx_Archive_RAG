import {
  runFinalAnswerVerification,
  shouldRunFinalAnswerVerification,
} from "./agent-answer-verification.js";
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
  webResult,
} = {}) => {
  if (researchBrief) {
    return researchBrief.citations ?? [];
  }

  if (ragResult?.ok) {
    return ragResult.value.citations ?? [];
  }

  if (webResult?.ok) {
    return webResult.citations ?? webResult.value?.citations ?? [];
  }

  return customSkillResults
    .filter((result) => result.ok)
    .flatMap((result) => result.citations ?? []);
};

export const finalizeAgentRun = async ({
  addTraceStep,
  arxivImportAnswer,
  buildAgentObservability,
  customSkillResults = [],
  customSkills = [],
  discoveryAnswer,
  documentRagSkill,
  getAgentSkills,
  getBudgetSnapshot,
  docIds = [],
  inventoryAnswer,
  plan,
  question,
  ragResult,
  recordAgentTrace,
  recordWorkingMemoryClaimSupport,
  recordWorkingMemoryGaps,
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
    webResult,
  });
  const baseAgentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: agentMode,
    },
    ragResult,
    webResult,
    customSkillResults,
    arxivImportAnswer,
    inventoryAnswer,
    discoveryAnswer,
    researchBrief,
  });
  const shouldFinalizeAnswer = shouldFinalizeAgentAnswer({
    agentMode,
    primaryCustomResult,
    ragSources,
    researchBrief,
    webResult,
  });

  addTraceStep({
    type: "synthesis",
    label: "Synthesis",
    summary: "Composed the final agent answer from completed tool results.",
    input: {
      agentMode,
      customSkillResultCount: customSkillResults.length,
      hasArxivImportAnswer: Boolean(arxivImportAnswer),
      hasDiscoveryAnswer: Boolean(discoveryAnswer),
      hasInventoryAnswer: Boolean(inventoryAnswer),
      hasRagResult: Boolean(ragResult),
      hasResearchBrief: Boolean(researchBrief),
      hasWebResult: Boolean(webResult),
      sourceCount: ragSources.length,
    },
    output: {
      answerLength: baseAgentAnswer.length,
      sourceCount: ragSources.length,
    },
    detail: {
      budget: getBudgetSnapshot(),
    },
  });

  const finalVerification = shouldRunFinalAnswerVerification({
    agentMode,
    primaryCustomResult,
    researchBrief,
    webResult,
  })
    ? runFinalAnswerVerification({
        addTraceStep,
        agentMode,
        answerText: baseAgentAnswer,
        citations: ragSources,
        docIds,
        documentRagSkill,
        primaryCustomResult,
        recordWorkingMemoryClaimSupport,
        recordWorkingMemoryGaps,
        researchBrief,
        webResult,
      })
    : {
        check: null,
        finalizer: null,
      };
  let finalizer = finalVerification.finalizer ?? null;

  if (!finalizer && shouldFinalizeAnswer && !finalVerification.check) {
    finalizer = finalizeAgentAnswer({
      answerText: baseAgentAnswer,
      citations: ragSources,
    });

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
      input: {
        answerLength: baseAgentAnswer.length,
        citationCount: ragSources.length,
      },
      output: {
        abstained: Boolean(finalizer.abstained),
        changed: Boolean(finalizer.changed),
        removedClaimCount: finalizer.removedClaims?.length ?? 0,
        unsupportedClaimCount:
          finalizer.claimSupport?.unsupportedClaimCount ?? 0,
      },
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
