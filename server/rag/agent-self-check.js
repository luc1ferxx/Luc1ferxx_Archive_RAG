import { extractMeaningfulTokens, normalizeSearchText } from "./text-utils.js";

export const CHECKABLE_CITATION_FIELDS = [
  "excerpt",
  "text",
  "pageContent",
  "content",
];

const normalizeEvidenceText = (value) => String(value ?? "").trim();

export const getCitationDocIds = (citations = []) =>
  new Set(
    citations
      .map((citation) => citation?.docId)
      .filter((docId) => typeof docId === "string" && docId.trim())
  );

export const hasCheckableCitationText = (citations = []) =>
  citations.some((citation) =>
    CHECKABLE_CITATION_FIELDS.some((field) =>
      normalizeEvidenceText(citation?.[field])
    )
  );

const SOURCE_LABEL_PATTERN = /\[(?:source|来源)\s*\d+\]/gi;
const NUMBER_PATTERN = /\b\d+(?:[.,]\d+)?%?\b/g;
const MONTH_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi;
const DATE_PATTERN = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g;
const CODE_PATTERN = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]{1,})+\b/g;
const CLAIM_SPLIT_PATTERN = /(?<=[.!?。！？])\s+|\n+|[;；]+/g;
const SUPPORT_TOKEN_OVERLAP_THRESHOLD = 0.6;

const uniqueValues = (values = []) => [...new Set(values.filter(Boolean))];

const stripSourceLabels = (value = "") =>
  String(value ?? "").replace(SOURCE_LABEL_PATTERN, "").trim();

const splitAnswerClaims = (answerText = "") =>
  stripSourceLabels(answerText)
    .split(CLAIM_SPLIT_PATTERN)
    .map((claim) => claim.trim())
    .map((claim) => claim.replace(/[.!?。！？]+$/g, "").trim())
    .filter((claim) => extractMeaningfulTokens(claim).length >= 2)
    .slice(0, 12);

const extractClaimAnchors = (claimText = "") =>
  uniqueValues([
    ...(claimText.match(NUMBER_PATTERN) ?? []),
    ...(claimText.match(MONTH_PATTERN) ?? []),
    ...(claimText.match(DATE_PATTERN) ?? []),
    ...(claimText.match(CODE_PATTERN) ?? []),
  ]).map((anchor) => ({
    text: anchor,
    normalized: normalizeSearchText(anchor),
  }));

const buildCitationSupportText = (citations = []) =>
  citations
    .map((citation) =>
      CHECKABLE_CITATION_FIELDS.map((field) => citation?.[field])
        .filter(Boolean)
        .join(" ")
    )
    .join("\n");

const hasAllAnchors = ({ anchors, supportText }) =>
  anchors.every((anchor) => supportText.includes(anchor.normalized));

const getTokenOverlap = ({ claimTerms, supportTerms }) => {
  if (claimTerms.length === 0) {
    return 1;
  }

  const matchedTerms = claimTerms.filter((term) => supportTerms.has(term));

  return Number((matchedTerms.length / claimTerms.length).toFixed(4));
};

export const evaluateClaimSupport = ({ answerText = "", citations = [] } = {}) => {
  const claims = splitAnswerClaims(answerText);
  const supportText = normalizeSearchText(buildCitationSupportText(citations));
  const supportTerms = new Set(extractMeaningfulTokens(supportText));

  if (claims.length === 0) {
    return {
      checked: false,
      supportedClaimCount: 0,
      unsupportedClaimCount: 0,
      claims: [],
    };
  }

  const checkedClaims = claims.map((claimText) => {
    const claimTerms = uniqueValues(extractMeaningfulTokens(claimText));
    const anchors = extractClaimAnchors(claimText);
    const tokenOverlap = getTokenOverlap({
      claimTerms,
      supportTerms,
    });
    const anchorsSupported = hasAllAnchors({
      anchors,
      supportText,
    });
    const supported =
      supportText.length > 0 &&
      anchorsSupported &&
      tokenOverlap >= SUPPORT_TOKEN_OVERLAP_THRESHOLD;

    return {
      text: claimText,
      supported,
      tokenOverlap,
      anchors: anchors.map((anchor) => anchor.text),
      missingAnchors: anchors
        .filter((anchor) => !supportText.includes(anchor.normalized))
        .map((anchor) => anchor.text),
    };
  });
  const unsupportedClaimCount = checkedClaims.filter((claim) => !claim.supported).length;

  return {
    checked: true,
    supportedClaimCount: checkedClaims.length - unsupportedClaimCount,
    unsupportedClaimCount,
    claims: checkedClaims,
  };
};

const getEvidenceScore = (ragResult) => {
  if (!ragResult?.ok) {
    return -1;
  }

  const value = ragResult.value ?? {};
  const citations = value.citations ?? [];
  const citedDocIds = getCitationDocIds(citations);
  const answerLength = typeof value.text === "string" ? value.text.trim().length : 0;
  const claimSupport = evaluateClaimSupport({
    answerText: value.text,
    citations,
  });

  return (
    citations.length * 2 +
    citedDocIds.size +
    (answerLength > 0 ? 1 : 0) +
    claimSupport.supportedClaimCount -
    claimSupport.unsupportedClaimCount * 3
  );
};

export const evaluateAnswerEvidence = ({
  answerLabel = "Document answer",
  answerText = "",
  citations = [],
  docIds = [],
  emptyAnswerReason = `${answerLabel} is empty.`,
  initialReasons = [],
  missingCheckableCitationReason = `${answerLabel} citations do not include checkable evidence text.`,
  missingCitationReason = `${answerLabel} has no citations.`,
  normalizeClaimSupport = (claimSupport) => claimSupport,
  requireCheckableCitationText = false,
  requireDocCoverage = true,
  retryRecommended = false,
  unsupportedClaimReason = (claimCount) =>
    `${claimCount} answer claim${claimCount === 1 ? "" : "s"} lacks citation support.`,
} = {}) => {
  const safeCitations = Array.isArray(citations) ? citations : [];
  const safeDocIds = Array.isArray(docIds) ? docIds : [];
  const citedDocIds = getCitationDocIds(safeCitations);
  const requiredDocCoverage = requireDocCoverage
    ? Math.min(Math.max(safeDocIds.length, 1), 2)
    : 0;
  const claimSupport = normalizeClaimSupport(
    evaluateClaimSupport({
      answerText,
      citations: safeCitations,
    })
  );
  const reasons = [...initialReasons];

  if (!normalizeEvidenceText(answerText)) {
    reasons.push(emptyAnswerReason);
  }

  if (safeCitations.length === 0) {
    reasons.push(missingCitationReason);
  }

  if (requireCheckableCitationText && !hasCheckableCitationText(safeCitations)) {
    reasons.push(missingCheckableCitationReason);
  }

  if (requiredDocCoverage > 1 && citedDocIds.size < requiredDocCoverage) {
    reasons.push(
      `Citations cover ${citedDocIds.size} of ${requiredDocCoverage} required documents.`
    );
  }

  if (claimSupport.unsupportedClaimCount > 0) {
    reasons.push(unsupportedClaimReason(claimSupport.unsupportedClaimCount));
  }

  const result = {
    answerLabel,
    citationCount: safeCitations.length,
    citedDocCount: citedDocIds.size,
    claimSupport,
    passed: reasons.length === 0,
    reasons,
    requiredCitationCount: 1,
    requiredDocCoverage,
    retryRecommended,
  };

  return {
    ...result,
    gaps: buildEvidenceGaps(result),
  };
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
      gaps: [
        {
          type: "skill_failure",
          severity: "blocking",
          message: "Document RAG failed.",
        },
      ],
    };
  }

  const value = ragResult.value ?? {};
  const result = evaluateAnswerEvidence({
    answerLabel: "Document answer",
    answerText: value.text,
    citations: value.citations ?? [],
    docIds,
    emptyAnswerReason: "Document answer is empty.",
    initialReasons: value.abstained
      ? ["Document RAG explicitly reported insufficient evidence."]
      : [],
    missingCitationReason: "Document answer has no citations.",
    requireDocCoverage: true,
    retryRecommended: false,
  });
  const retryRecommended = !result.passed && !value.abstained && ragResult.ok;

  return {
    ...result,
    retryRecommended,
  };
};

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

export const selectBetterRagResult = ({ primary, retry } = {}) => {
  if (!retry?.ok) {
    return primary;
  }

  if (!primary?.ok) {
    return retry;
  }

  return getEvidenceScore(retry) > getEvidenceScore(primary) ? retry : primary;
};
