export function buildEvidenceGaps(check = {}) {
  const gaps = [];
  const answerLabel = check.answerLabel ?? "Document answer";

  if (check.reasons?.some((reason) => /insufficient evidence/i.test(reason))) {
    gaps.push({
      type: "insufficient_evidence",
      severity: "blocking",
      message: "Document RAG reported insufficient evidence.",
    });
  }

  if (check.reasons?.some((reason) => /empty/i.test(reason))) {
    gaps.push({
      type: "empty_answer",
      severity: "blocking",
      message: `${answerLabel} is empty.`,
    });
  }

  if (check.citationCount === 0) {
    gaps.push({
      type: "missing_citations",
      severity: "blocking",
      message: `${answerLabel} has no citations.`,
    });
  }

  if (
    Number.isFinite(Number(check.requiredDocCoverage)) &&
    Number(check.requiredDocCoverage) > 1 &&
    Number(check.citedDocCount) < Number(check.requiredDocCoverage)
  ) {
    gaps.push({
      type: "document_coverage",
      severity: "repairable",
      message: `Citations cover ${check.citedDocCount ?? 0} of ${
        check.requiredDocCoverage
      } required documents.`,
      citedDocCount: check.citedDocCount ?? 0,
      requiredDocCoverage: check.requiredDocCoverage,
    });
  }

  for (const claim of check.claimSupport?.claims ?? []) {
    if (claim.supported) {
      continue;
    }

    gaps.push({
      type: "unsupported_claim",
      severity: "repairable",
      message: "Answer claim lacks citation support.",
      claim: claim.text,
      missingAnchors: claim.missingAnchors ?? [],
      tokenOverlap: claim.tokenOverlap ?? null,
    });
  }

  return gaps.length > 0
    ? gaps
    : (check.reasons ?? []).map((reason) => ({
        type: "evidence_check",
        severity: "repairable",
        message: reason,
      }));
}

/**
 * The question a follow-up document RAG call asks: the question itself, as the
 * primary call resolved it when there is one ("And how quickly?" alone finds
 * nothing). The evidence issues reach only the follow-up retrieval queries
 * (agent-retrieval-queries.js).
 */
export const buildFollowUpQuestion = ({ question, resolvedQuestion = null } = {}) => {
  const resolved = typeof resolvedQuestion === "string" ? resolvedQuestion.trim() : "";

  return resolved || question;
};
