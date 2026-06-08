import { evaluateClaimSupport } from "./agent-self-check.js";

const SOURCE_LABEL_PATTERN = /\[(?:source|来源)\s*\d+\]/gi;
const SENTENCE_END_PATTERN = /[.!?。！？]$/;

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeSourceLabel = (citation, index) => {
  const rank = Number.isFinite(Number(citation?.rank))
    ? Number(citation.rank)
    : Math.max(index, 0) + 1;

  return `[Source ${rank}]`;
};

const buildSourceLabelSuffix = (citations = [], allCitations = citations) =>
  citations
    .map((citation) =>
      normalizeSourceLabel(citation, allCitations.indexOf(citation))
    )
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

const stripSourceLabels = (value = "") =>
  String(value ?? "").replace(SOURCE_LABEL_PATTERN, "").trim();

const ensureTerminalPunctuation = (value = "") =>
  SENTENCE_END_PATTERN.test(value) ? value : `${value}.`;

const getSupportingCitations = ({ claimText, citations = [] }) => {
  const supportingCitations = citations.filter((citation) => {
    const check = evaluateClaimSupport({
      answerText: claimText,
      citations: [citation],
    });

    return (
      check.checked &&
      check.supportedClaimCount > 0 &&
      check.unsupportedClaimCount === 0
    );
  });

  return supportingCitations.length > 0 ? supportingCitations : citations;
};

const formatSupportedClaim = ({ claimText, citations }) => {
  const stripped = stripSourceLabels(claimText).replace(/^[-*]\s+/, "").trim();

  if (!hasText(stripped)) {
    return "";
  }

  const sentence = ensureTerminalPunctuation(stripped);
  const supportingCitations = getSupportingCitations({
    claimText: stripped,
    citations,
  });
  const sourceLabelSuffix = buildSourceLabelSuffix(supportingCitations, citations);

  return sourceLabelSuffix ? `${sentence} ${sourceLabelSuffix}` : sentence;
};

const buildFinalizedText = ({ claimSupport, citations }) => {
  const supportedClaims = claimSupport.claims.filter((claim) => claim.supported);

  if (supportedClaims.length === 0) {
    return "I do not have enough citation-backed evidence to answer reliably.";
  }

  return supportedClaims
    .map((claim) =>
      formatSupportedClaim({
        claimText: claim.text,
        citations,
      })
    )
    .filter(Boolean)
    .join("\n");
};

export const finalizeAgentAnswer = ({ answerText = "", citations = [] } = {}) => {
  const text = String(answerText ?? "").trim();
  const claimSupport = evaluateClaimSupport({
    answerText: text,
    citations,
  });

  if (!hasText(text) || citations.length === 0 || !claimSupport.checked) {
    return {
      text,
      changed: false,
      abstained: false,
      removedClaims: [],
      claimSupport,
    };
  }

  const unsupportedClaims = claimSupport.claims.filter((claim) => !claim.supported);

  if (unsupportedClaims.length === 0) {
    return {
      text,
      changed: false,
      abstained: false,
      removedClaims: [],
      claimSupport,
    };
  }

  return {
    text: buildFinalizedText({
      claimSupport,
      citations,
    }),
    changed: true,
    abstained: claimSupport.supportedClaimCount === 0,
    removedClaims: unsupportedClaims.map((claim) => claim.text),
    claimSupport,
  };
};
