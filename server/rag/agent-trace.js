export const buildStep = ({
  id,
  index,
  type,
  label,
  status = "completed",
  summary,
  detail,
  input,
  output,
  error,
}) => ({
  id: id ?? `${index}-${type}`,
  type,
  label,
  status,
  summary,
  detail: detail ?? null,
  ...(input === undefined ? {} : { input }),
  ...(output === undefined ? {} : { output }),
  ...(error === undefined ? {} : { error }),
});

export const buildSelfCheckSummary = (check) => {
  if (check.passed) {
    return `Evidence check passed with ${check.citationCount} citation${
      check.citationCount === 1 ? "" : "s"
    } across ${check.citedDocCount} cited document${
      check.citedDocCount === 1 ? "" : "s"
    }.`;
  }

  return `Evidence check needs attention: ${check.reasons.join(" ")}`;
};

export const buildGapAnalysisSummary = (gaps = []) => {
  if (gaps.length === 0) {
    return "No evidence gaps require follow-up.";
  }

  const gapTypes = [...new Set(gaps.map((gap) => gap.type ?? "evidence_gap"))];

  return `Identified ${gaps.length} evidence gap${
    gaps.length === 1 ? "" : "s"
  } for follow-up: ${gapTypes.join(", ")}.`;
};

export const buildFinalizerSummary = (finalizer) => {
  if (!finalizer.changed) {
    return `Final answer passed claim-level citation finalization with ${
      finalizer.claimSupport.supportedClaimCount
    } supported claim${finalizer.claimSupport.supportedClaimCount === 1 ? "" : "s"}.`;
  }

  if (finalizer.abstained) {
    return `Finalizer removed ${finalizer.removedClaims.length} unsupported claim${
      finalizer.removedClaims.length === 1 ? "" : "s"
    } and returned an evidence-limited answer.`;
  }

  return `Finalizer removed ${finalizer.removedClaims.length} unsupported claim${
    finalizer.removedClaims.length === 1 ? "" : "s"
  } from the final answer.`;
};

export const buildQueryPlannerSummary = (retrievalPlan) =>
  `Planned ${retrievalPlan.retrievalQueries.length} ${retrievalPlan.intent} retrieval quer${
    retrievalPlan.retrievalQueries.length === 1 ? "y" : "ies"
  } with ${retrievalPlan.retrievalOptions.profile} topK profile.`;

export const buildAgentTraceSummary = (trace = []) =>
  trace.map((step) => ({
    type: step.type,
    label: step.label,
    status: step.status ?? "completed",
  }));
