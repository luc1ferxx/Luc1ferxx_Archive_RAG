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
import { rebaseEvidenceResults } from "./source-labels.js";
import { attachRetrievedEvidence } from "./citations.js";

export const resolveAgentMode = ({ plan, ragResult, webResult } = {}) =>
  ragResult?.ok && ragResult.value.abstained && webResult?.ok
    ? "document_web"
    : plan.mode;

export const selectPrimaryCustomResult = (customSkillResults = []) =>
  customSkillResults.find((result) => result.ok);

const getComparisonAnalysisSummary = (result) =>
  result?.comparisonAnalysisSummary ??
  result?.value?.comparisonAnalysisSummary ??
  null;

const attachResultRetrievedEvidence = (result = {}) => ({
  ...result,
  citations: attachRetrievedEvidence({
    citations: result.citations ?? result.value?.citations ?? [],
    retrievedContexts:
      result.retrievedContexts ?? result.value?.retrievedContexts ?? [],
  }),
});

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
  actionAnswer,
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
  const rebasedCustomSkillResults = rebaseEvidenceResults(
    customSkillResults
  ).results;
  const rebasedCustomEvidenceResults = rebaseEvidenceResults(
    customSkillResults.map(attachResultRetrievedEvidence)
  ).results;
  const primaryCustomResult = selectPrimaryCustomResult(
    rebasedCustomSkillResults
  );
  const directAnswerModes = buildDirectAnswerModes({
    customSkills,
  });
  const ragSources = selectRagSources({
    customSkillResults: rebasedCustomSkillResults,
    ragResult,
    researchBrief,
    webResult,
  });
  const verificationSources = researchBrief
    ? researchBrief.evidenceCitations ?? ragSources
    : ragResult?.ok
    ? attachRetrievedEvidence({
        citations: ragSources,
        retrievedContexts: ragResult.value?.retrievedContexts ?? [],
      })
    : webResult?.ok
    ? ragSources
    : selectRagSources({
        customSkillResults: rebasedCustomEvidenceResults,
      });
  const baseAgentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: agentMode,
    },
    actionAnswer,
    ragResult,
    webResult,
    customSkillResults: rebasedCustomSkillResults,
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
  const customComparisonResult = rebasedCustomSkillResults.find(
    (result) => result.ok && getComparisonAnalysisSummary(result)
  );
  const comparisonAnalysisSummary = customComparisonResult
    ? getComparisonAnalysisSummary(customComparisonResult)
    : !primaryCustomResult && !researchBrief && ragResult?.ok && !webResult?.ok
    ? ragResult.value.comparisonAnalysisSummary ?? null
    : null;

  addTraceStep({
    type: "synthesis",
    label: "Synthesis",
    summary: "Composed the final agent answer from completed tool results.",
    input: {
      agentMode,
      customSkillResultCount: customSkillResults.length,
      hasActionAnswer: Boolean(actionAnswer),
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
        evidenceCitations: verificationSources,
        comparisonAnalysisSummary,
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
      evidenceCitations: verificationSources,
      comparisonAnalysisSummary,
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
