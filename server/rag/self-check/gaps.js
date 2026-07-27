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

export const buildEvidenceRetryQuestion = ({ question, check } = {}) => {
  const reasonText = check?.reasons?.length
    ? check.reasons.join(" ")
    : "The first answer did not provide enough grounded evidence.";

  return [
    "Re-check the uploaded documents for cited support before answering.",
    `Original question: ${question}`,
    `Evidence issue: ${reasonText}`,
    check?.claimSupport?.unsupportedClaimCount
      ? `Unsupported claims: ${check.claimSupport.claims
          .filter((claim) => !claim.supported)
          .map((claim) => claim.text)
          .join(" | ")}`
      : "",
    "Return the best answer only if it is backed by page-level citations.",
  ].filter(Boolean).join("\n");
};
