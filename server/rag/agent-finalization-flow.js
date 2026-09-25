import {
  runFinalAnswerVerification,
  shouldRunFinalAnswerVerification,
} from "./agent-answer-verification.js";
import { finalizeAgentAnswer } from "./agent-finalizer.js";
import { evaluateClaimSupport } from "./agent-self-check.js";
import { getClaimJudgeMode } from "./config.js";
import { judgeClaimSupport } from "./self-check/claim-judge.js";
import {
  projectGroundedAnswer,
  projectGroundedRankedContent,
} from "./grounded-answer-projection.js";
import {
  buildDirectAnswerModes,
  buildSynthesisAnswer,
  shouldFinalizeAgentAnswer,
} from "./agent-synthesis.js";
import { buildAgentResponse } from "./agent-response-builder.js";
import { buildFinalizerSummary } from "./agent-trace.js";
import { rebaseEvidenceResults } from "./source-labels.js";
import {
  attachRetrievedEvidence,
  hasCompatibleEvidenceIdentity,
} from "./citations.js";

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

const getCitationRank = (citation, index) => {
  const rank = Number(citation?.rank);

  return Number.isInteger(rank) && rank > 0 ? rank : index + 1;
};

const rebaseResearchFindings = (researchBrief, rebasedBrief) => {
  const sourceRankMap = new Map(
    (researchBrief.citations ?? []).map((citation, index) => [
      getCitationRank(citation, index),
      rebasedBrief.citations[index]?.rank,
    ])
  );

  return {
    ...rebasedBrief,
    findings: (researchBrief.findings ?? []).map((finding) => {
      const projected = projectGroundedRankedContent({
        text: finding.text,
        citations: finding.citations,
        sourceRankMap,
      });

      return {
        ...finding,
        ...(typeof finding.text === "string" ? { text: projected.text } : {}),
        ...(Array.isArray(finding.citations)
          ? { citations: projected.citations }
          : {}),
      };
    }),
  };
};

const attachResearchEvidence = (researchBrief = {}) => ({
  ...researchBrief,
  citations: (researchBrief.citations ?? []).map((citation) => {
    const evidence = (researchBrief.evidenceCitations ?? []).find((candidate) =>
      hasCompatibleEvidenceIdentity(citation, candidate)
    );

    return evidence?.evidenceText
      ? { ...citation, evidenceText: evidence.evidenceText }
      : citation;
  }),
});

const rebaseGraphEvidence = ({
  customSkillResults = [],
  ragResult,
  researchBrief,
  webResult,
  withRetrievedEvidence = false,
} = {}) => {
  const customResults = withRetrievedEvidence
    ? customSkillResults.map(attachResultRetrievedEvidence)
    : customSkillResults;
  const ragInput = ragResult?.ok
    ? {
        citations: ragResult.value?.citations ?? ragResult.citations ?? [],
        retrievedContexts: ragResult.value?.retrievedContexts ?? [],
        text: ragResult.value?.text ?? ragResult.text ?? "",
      }
    : null;
  const webInput = webResult?.ok
    ? {
        citations: webResult.citations ?? webResult.value?.citations ?? [],
        retrievedContexts:
          webResult.retrievedContexts ?? webResult.value?.retrievedContexts ?? [],
        text: webResult.text ?? webResult.value?.text ?? "",
      }
    : null;
  const researchInput = researchBrief
    ? withRetrievedEvidence
      ? attachResearchEvidence(researchBrief)
      : researchBrief
    : null;
  const inputs = [
    ...customResults,
    ...(researchInput ? [researchInput] : []),
    ...(ragInput ? [withRetrievedEvidence ? attachResultRetrievedEvidence(ragInput) : ragInput] : []),
    ...(webInput ? [withRetrievedEvidence ? attachResultRetrievedEvidence(webInput) : webInput] : []),
  ];
  const results = rebaseEvidenceResults(inputs).results;
  const customCount = customResults.length;
  const researchOffset = researchInput ? 1 : 0;
  const ragOffset = ragInput ? 1 : 0;

  return {
    customResults: results.slice(0, customCount),
    research: researchInput
      ? rebaseResearchFindings(researchBrief, results[customCount])
      : null,
    rag: ragInput ? results[customCount + researchOffset] : null,
    web: webInput ? results[customCount + researchOffset + ragOffset] : null,
  };
};

const synchronizeTraceClaimSupport = ({ trace, claimSupport } = {}) => {
  if (!Array.isArray(trace) || !claimSupport) {
    return;
  }

  for (const [index, step] of trace.entries()) {
    const isFinalAnswerSelfCheck =
      step?.type === "self_check" && step.detail?.finalAnswer === true;
    const isAnswerFinalizer = step?.type === "answer_finalizer";

    if (
      (!isFinalAnswerSelfCheck && !isAnswerFinalizer) ||
      !step?.detail?.claimSupport
    ) {
      continue;
    }

    trace[index] = {
      ...step,
      detail: {
        ...step.detail,
        claimSupport,
      },
    };
  }
};

export const selectRagSources = ({
  customSkillResults = [],
  includeCustomEvidence = false,
  ragResult,
  researchBrief,
  webResult,
} = {}) => {
  const customSources = customSkillResults
    .filter((result) => result.ok)
    .flatMap((result) => result.citations ?? []);

  if (includeCustomEvidence) {
    return [
      ...customSources,
      ...(researchBrief ? researchBrief.citations ?? [] : []),
      ...(ragResult?.ok ? ragResult.value?.citations ?? [] : []),
      ...(webResult?.ok ? webResult.citations ?? webResult.value?.citations ?? [] : []),
    ];
  }

  if (researchBrief) {
    return researchBrief.citations ?? [];
  }

  if (ragResult?.ok) {
    return ragResult.value.citations ?? [];
  }

  if (webResult?.ok) {
    return webResult.citations ?? webResult.value?.citations ?? [];
  }

  return customSources;
};

export const finalizeAgentRun = async ({
  actionAnswer,
  addTraceStep,
  arxivImportAnswer,
  buildAgentObservability,
  customSkillResults = [],
  customSkillGraphExecuted = false,
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
  const rebased = customSkillGraphExecuted
    ? rebaseGraphEvidence({ customSkillResults, ragResult, researchBrief, webResult })
    : { customResults: rebaseEvidenceResults(customSkillResults).results };
  const rebasedEvidence = customSkillGraphExecuted
    ? rebaseGraphEvidence({
        customSkillResults,
        ragResult,
        researchBrief,
        webResult,
        withRetrievedEvidence: true,
      })
    : {
        customResults: rebaseEvidenceResults(
          customSkillResults.map(attachResultRetrievedEvidence)
        ).results,
      };
  const rebasedCustomSkillResults = rebased.customResults;
  const rebasedCustomEvidenceResults = rebasedEvidence.customResults;
  const effectiveResearchBrief = rebased.research
    ? {
        ...rebased.research,
        evidenceCitations: rebasedEvidence.research?.citations ?? [],
      }
    : researchBrief;
  const effectiveRagResult = rebased.rag
    ? {
        ...ragResult,
        citations: rebased.rag.citations,
        text: rebased.rag.text,
        value: {
          ...ragResult.value,
          citations: rebased.rag.citations,
          text: rebased.rag.text,
        },
      }
    : ragResult;
  const effectiveWebResult = rebased.web
    ? {
        ...webResult,
        citations: rebased.web.citations,
        text: rebased.web.text,
        value: {
          ...(webResult.value ?? {}),
          citations: rebased.web.citations,
          text: rebased.web.text,
        },
      }
    : webResult;
  const primaryCustomResult = selectPrimaryCustomResult(
    rebasedCustomSkillResults
  );
  const directAnswerModes = buildDirectAnswerModes({
    customSkills,
  });
  if (customSkillGraphExecuted && primaryCustomResult) {
    directAnswerModes.add(plan.mode);
  }
  const ragSources = selectRagSources({
    customSkillResults: rebasedCustomSkillResults,
    includeCustomEvidence: customSkillGraphExecuted,
    ragResult: effectiveRagResult,
    researchBrief: effectiveResearchBrief,
    webResult: effectiveWebResult,
  });
  const verificationSources = effectiveResearchBrief
    ? effectiveResearchBrief.evidenceCitations ?? ragSources
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
  const graphVerificationSources = customSkillGraphExecuted
    ? [
        ...selectRagSources({ customSkillResults: rebasedCustomEvidenceResults }),
        ...(rebasedEvidence.research?.citations ?? []),
        ...(rebasedEvidence.rag?.citations ?? []),
        ...(rebasedEvidence.web?.citations ?? []),
      ]
    : verificationSources;
  const baseAgentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: agentMode,
    },
    actionAnswer,
    ragResult: effectiveRagResult,
    webResult: effectiveWebResult,
    customSkillResults: rebasedCustomSkillResults,
    customSkillGraphExecuted,
    arxivImportAnswer,
    inventoryAnswer,
    discoveryAnswer,
    researchBrief: effectiveResearchBrief,
  });
  const shouldFinalizeAnswer = shouldFinalizeAgentAnswer({
    agentMode,
    primaryCustomResult,
    ragSources,
    researchBrief: effectiveResearchBrief,
    webResult: effectiveWebResult,
  });
  const customComparisonResult = rebasedCustomSkillResults.find(
    (result) => result.ok && getComparisonAnalysisSummary(result)
  );
  const comparisonAnalysisSummary = customComparisonResult
    ? getComparisonAnalysisSummary(customComparisonResult)
    : !primaryCustomResult && !effectiveResearchBrief && effectiveRagResult?.ok && !effectiveWebResult?.ok
    ? effectiveRagResult.value.comparisonAnalysisSummary ?? null
    : null;
  const verifyMixedResearchGraph = Boolean(
    customSkillGraphExecuted && primaryCustomResult && effectiveResearchBrief
  );

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
    researchBrief: effectiveResearchBrief,
    webResult,
  })
    ? runFinalAnswerVerification({
        addTraceStep,
        // A mixed graph answer contains both research findings and atomic
        // Skill output. The research-only verifier checks findings alone and
        // would silently drop the graph claims from finalization.
        agentMode: verifyMixedResearchGraph
          ? primaryCustomResult.skillId
          : agentMode,
        answerText: baseAgentAnswer,
        citations: ragSources,
        evidenceCitations: graphVerificationSources,
        comparisonAnalysisSummary,
        docIds,
        documentRagSkill,
        primaryCustomResult,
        recordWorkingMemoryClaimSupport,
        recordWorkingMemoryGaps,
        researchBrief: verifyMixedResearchGraph ? null : effectiveResearchBrief,
        webResult: effectiveWebResult,
      })
    : {
        check: null,
        finalizer: null,
      };
  let finalizer = finalVerification.finalizer ?? null;

  if (!finalizer && shouldFinalizeAnswer && !finalVerification.check) {
    // With RAG_CLAIM_JUDGE=llm, claims the lexical check rejects get a second
    // opinion before the finalizer removes them; verdicts the document loop
    // already obtained for the same claim and evidence come from the cache.
    const judgedClaimSupport = getClaimJudgeMode() === "llm"
      ? await judgeClaimSupport({
          citations: graphVerificationSources,
          claimSupport: evaluateClaimSupport({
            answerText: baseAgentAnswer,
            citations: graphVerificationSources,
            comparisonAnalysisSummary,
          }),
          comparisonAnalysisSummary,
        })
      : null;

    finalizer = finalizeAgentAnswer({
      answerText: baseAgentAnswer,
      citations: ragSources,
      evidenceCitations: graphVerificationSources,
      comparisonAnalysisSummary,
      claimSupport: judgedClaimSupport,
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

  const finalAnswerProjection = finalizer
    ? projectGroundedAnswer({
        text: finalizer.text,
        citations: ragSources,
        retrievedContexts: customSkillGraphExecuted
          ? graphVerificationSources
              .filter((citation) => citation.evidenceText)
              .map((citation) => ({ ...citation, text: citation.evidenceText }))
          : effectiveResearchBrief?.retrievedContexts ??
            (effectiveRagResult?.ok ? effectiveRagResult.value?.retrievedContexts : null) ??
            primaryCustomResult?.retrievedContexts ??
            primaryCustomResult?.value?.retrievedContexts ??
            effectiveWebResult?.retrievedContexts ??
            effectiveWebResult?.value?.retrievedContexts ??
            [],
        claimSupport: finalizer.claimSupport,
      })
    : null;
  const publicFinalizer = finalizer
    ? {
        ...finalizer,
        text: finalAnswerProjection.text,
        claimSupport: finalAnswerProjection.claimSupport,
      }
    : null;
  const publicRagSources = finalAnswerProjection?.citations ?? ragSources;

  if (finalAnswerProjection) {
    synchronizeTraceClaimSupport({
      trace,
      claimSupport: finalAnswerProjection.claimSupport,
    });
  }

  const agentObservability = buildAgentObservability({
    agentMode,
  });
  const agentSkills = getAgentSkills();
  const agentResponse = buildAgentResponse({
    agentMode,
    baseAgentAnswer,
    customSkillGraphExecuted,
    directAnswerModes,
    finalizer: publicFinalizer,
    plan,
    primaryCustomResult,
    question,
    ragResult: effectiveRagResult,
    ragSources: publicRagSources,
    researchBrief: effectiveResearchBrief,
    shouldRunWeb,
    skippedWebBecauseBudget,
    trace,
    agentSkills,
    agentObservability,
    finalAnswerSourceRankMap: finalAnswerProjection?.sourceRankMap,
    workingMemory,
    webResult: effectiveWebResult,
  });

  await recordAgentTrace({
    agentMode,
    agentSkills,
    agentObservability,
    status: agentResponse.status,
  });

  return agentResponse;
};
