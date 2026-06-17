import {
  finalizeAgentAnswer,
  normalizeClaimSupportForHeadings,
} from "./agent-finalizer.js";
import {
  buildEvidenceGaps,
  evaluateAnswerEvidence,
  hasCheckableCitationText,
} from "./agent-self-check.js";
import {
  buildFinalizerSummary,
  buildGapAnalysisSummary,
  buildSelfCheckSummary,
} from "./agent-trace.js";
import { SKILL_CHAIN_MODE } from "./agent-planner.js";

export { hasCheckableCitationText };

export const evaluateFinalAnswerEvidence = ({
  answerText = "",
  citations = [],
  docIds = [],
  requireDocCoverage = false,
} = {}) =>
  evaluateAnswerEvidence({
    answerLabel: "Final answer",
    answerText,
    citations,
    docIds,
    emptyAnswerReason: "Final answer is empty.",
    missingCheckableCitationReason:
      "Final answer citations do not include checkable evidence text.",
    missingCitationReason: "Final answer has no citations.",
    normalizeClaimSupport: normalizeClaimSupportForHeadings,
    requireCheckableCitationText: true,
    requireDocCoverage,
    retryRecommended: false,
    unsupportedClaimReason: (claimCount) =>
      `${claimCount} final answer claim${
        claimCount === 1 ? "" : "s"
      } lacks citation support.`,
  });

const getPrimaryVerificationSkill = ({
  agentMode,
  documentRagSkill,
  primaryCustomResult,
  researchBrief,
  webResult,
} = {}) => {
  if (primaryCustomResult) {
    return primaryCustomResult;
  }

  if (agentMode === "research_brief" && researchBrief) {
    return {
      id: "research_brief",
      version: researchBrief.version ?? "1.0.0",
      label: "Research Brief",
    };
  }

  if (webResult?.ok) {
    return {
      id: webResult.skillId ?? "web_search",
      version: webResult.skillVersion ?? "1.0.0",
      label: webResult.label ?? "Web Search",
    };
  }

  if (documentRagSkill) {
    return documentRagSkill;
  }

  return {
    id: "answer_finalizer",
    version: "1.0.0",
    label: "Answer Finalizer",
  };
};

const buildFinalizedResearchBriefText = ({ finalizer } = {}) => [
  "Executive Summary",
  finalizer.abstained
    ? "I do not have enough citation-backed evidence to answer reliably."
    : "The research brief was finalized to citation-backed findings.",
  "",
  "Key Findings",
  finalizer.text,
].join("\n");

export const shouldRunFinalAnswerVerification = ({
  agentMode,
  primaryCustomResult,
  researchBrief,
  webResult,
} = {}) =>
  Boolean(
    primaryCustomResult ||
      agentMode === SKILL_CHAIN_MODE ||
      researchBrief ||
      webResult?.ok
  );

export const runFinalAnswerVerification = ({
  addTraceStep,
  agentMode,
  answerText,
  citations = [],
  docIds = [],
  documentRagSkill,
  primaryCustomResult,
  recordWorkingMemoryClaimSupport,
  recordWorkingMemoryGaps,
  researchBrief,
  webResult,
} = {}) => {
  if (
    !shouldRunFinalAnswerVerification({
      agentMode,
      primaryCustomResult,
      researchBrief,
      webResult,
    })
  ) {
    return {
      check: null,
      finalizer: null,
    };
  }

  const verificationSkill = getPrimaryVerificationSkill({
    agentMode,
    documentRagSkill,
    primaryCustomResult,
    researchBrief,
    webResult,
  });
  const verificationAnswerText =
    agentMode === "research_brief" && Array.isArray(researchBrief?.findings)
      ? researchBrief.findings
          .filter((finding) => finding?.status === "completed")
          .map((finding) => finding.text)
          .filter(Boolean)
          .join("\n")
      : answerText;
  const check = evaluateFinalAnswerEvidence({
    answerText: verificationAnswerText || answerText,
    citations,
    docIds,
    requireDocCoverage:
      agentMode === SKILL_CHAIN_MODE || Boolean(primaryCustomResult || researchBrief),
  });

  recordWorkingMemoryClaimSupport?.({
    skill: verificationSkill,
    phase: "final",
    check,
  });

  addTraceStep?.({
    type: "self_check",
    label: "Final Self Check",
    status: check.passed ? "completed" : "failed",
    summary: buildSelfCheckSummary(check),
    detail: {
      ...check,
      finalAnswer: true,
    },
  });

  if (!check.passed) {
    const gaps = (check.gaps?.length ? check.gaps : buildEvidenceGaps(check)).map(
      (gap) => ({
        ...gap,
        skillId: verificationSkill.id ?? verificationSkill.skillId,
        skillVersion: verificationSkill.version ?? verificationSkill.skillVersion,
      })
    );

    recordWorkingMemoryGaps?.({
      gaps,
      phase: "final",
    });

    addTraceStep?.({
      type: "gap_analysis",
      label: "Final Gap Analysis",
      status: gaps.length > 0 ? "completed" : "skipped",
      summary: buildGapAnalysisSummary(gaps),
      detail: {
        finalAnswer: true,
        followUpRecommended: false,
        gaps,
        skillId: verificationSkill.id ?? verificationSkill.skillId,
        skillVersion: verificationSkill.version ?? verificationSkill.skillVersion,
      },
    });
  }

  if (!hasCheckableCitationText(citations)) {
    addTraceStep?.({
      type: "answer_finalizer",
      label: "Answer Finalizer",
      status: "skipped",
      summary:
        "Finalizer skipped because no checkable citation text was available.",
      detail: {
        changed: false,
        abstained: false,
        removedClaims: [],
        claimSupport: check.claimSupport,
        skippedReason: "missing_checkable_citation_text",
      },
    });

    return {
      check,
      finalizer: null,
    };
  }

  if (agentMode === "research_brief") {
    const researchFinalizer = finalizeAgentAnswer({
      answerText: verificationAnswerText || answerText,
      citations,
    });
    const finalizer = researchFinalizer.changed
      ? {
          ...researchFinalizer,
          text: buildFinalizedResearchBriefText({
            finalizer: researchFinalizer,
          }),
        }
      : null;

    addTraceStep?.({
      type: "answer_finalizer",
      label: "Answer Finalizer",
      summary: finalizer
        ? buildFinalizerSummary(finalizer)
        : check.passed
        ? "Research brief findings passed claim-level citation finalization."
        : "Research brief finalizer kept the structured brief and recorded unsupported finding gaps.",
      detail: {
        changed: Boolean(finalizer?.changed),
        abstained: Boolean(finalizer?.abstained),
        removedClaims: finalizer?.removedClaims ?? [],
        claimSupport: finalizer?.claimSupport ?? check.claimSupport,
        finalizedScope: "research_findings",
      },
    });

    return {
      check,
      finalizer,
    };
  }

  const finalizer = finalizeAgentAnswer({
    answerText,
    citations,
  });

  addTraceStep?.({
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

  return {
    check,
    finalizer,
  };
};
