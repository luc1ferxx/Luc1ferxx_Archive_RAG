const getCitationDocIds = (citations = []) =>
  new Set(
    citations
      .map((citation) => citation?.docId)
      .filter((docId) => typeof docId === "string" && docId.trim())
  );

const getEvidenceScore = (ragResult) => {
  if (!ragResult?.ok) {
    return -1;
  }

  const value = ragResult.value ?? {};
  const citations = value.citations ?? [];
  const citedDocIds = getCitationDocIds(citations);
  const answerLength = typeof value.text === "string" ? value.text.trim().length : 0;

  return citations.length * 2 + citedDocIds.size + (answerLength > 0 ? 1 : 0);
};

export const evaluateDocumentEvidence = ({ ragResult, docIds = [] } = {}) => {
  if (!ragResult?.ok) {
    return {
      passed: false,
      retryRecommended: false,
      reasons: ["Document RAG failed."],
      citationCount: 0,
      citedDocCount: 0,
      requiredCitationCount: 1,
      requiredDocCoverage: Math.min(Math.max(docIds.length, 1), 2),
    };
  }

  const value = ragResult.value ?? {};
  const citations = value.citations ?? [];
  const citedDocIds = getCitationDocIds(citations);
  const requiredDocCoverage = Math.min(Math.max(docIds.length, 1), 2);
  const reasons = [];

  if (value.abstained) {
    reasons.push("Document RAG explicitly reported insufficient evidence.");
  }

  if (!value.text?.trim()) {
    reasons.push("Document answer is empty.");
  }

  if (citations.length === 0) {
    reasons.push("Document answer has no citations.");
  }

  if (docIds.length > 1 && citedDocIds.size < requiredDocCoverage) {
    reasons.push(
      `Citations cover ${citedDocIds.size} of ${requiredDocCoverage} required documents.`
    );
  }

  const passed = reasons.length === 0;

  return {
    passed,
    retryRecommended: !passed && !value.abstained && ragResult.ok,
    reasons,
    citationCount: citations.length,
    citedDocCount: citedDocIds.size,
    requiredCitationCount: 1,
    requiredDocCoverage,
  };
};

export const buildEvidenceRetryQuestion = ({ question, check } = {}) => {
  const reasonText = check?.reasons?.length
    ? check.reasons.join(" ")
    : "The first answer did not provide enough grounded evidence.";

  return [
    "Re-check the uploaded documents for cited support before answering.",
    `Original question: ${question}`,
    `Evidence issue: ${reasonText}`,
    "Return the best answer only if it is backed by page-level citations.",
  ].join("\n");
};

export const selectBetterRagResult = ({ primary, retry } = {}) => {
  if (!retry?.ok) {
    return primary;
  }

  if (!primary?.ok) {
    return retry;
  }

  return getEvidenceScore(retry) > getEvidenceScore(primary) ? retry : primary;
};
