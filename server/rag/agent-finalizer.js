import { evaluateClaimSupport } from "./agent-self-check.js";

const SOURCE_LABEL_PATTERN = /\[(?:source|来源)\s*\d+\]/gi;
const SENTENCE_END_PATTERN = /[.!?。！？]$/;
const SECTION_HEADING_PATTERN =
  /^(?:risk review|risks?|gaps?|conflicts?(?: or exceptions?)?|exceptions?|evidence limits?|executive summary|key findings|summary|evidence by document|recommended next questions)$/i;

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

const normalizeHeadingText = (value = "") =>
  stripSourceLabels(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/:$/g, "")
    .trim();

const isPreservedHeading = (value = "") =>
  SECTION_HEADING_PATTERN.test(normalizeHeadingText(value));

const getPreservedHeadings = (answerText = "") =>
  String(answerText ?? "")
    .split(/\n+/g)
    .map(normalizeHeadingText)
    .filter((line) => line && isPreservedHeading(line))
    .slice(0, 3);

const normalizeClaimSupportForHeadings = (claimSupport) => {
  const claims = (claimSupport.claims ?? []).map((claim) =>
    !claim.supported && isPreservedHeading(claim.text)
      ? {
          ...claim,
          supported: true,
          heading: true,
          missingAnchors: [],
        }
      : claim
  );
  const unsupportedClaimCount = claims.filter((claim) => !claim.supported).length;

  return {
    ...claimSupport,
    supportedClaimCount: claims.filter(
      (claim) => claim.supported && !claim.heading
    ).length,
    unsupportedClaimCount,
    claims,
  };
};

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

const buildFinalizedText = ({ answerText, claimSupport, citations }) => {
  const supportedClaims = claimSupport.claims.filter((claim) => claim.supported);
  const supportedEvidenceClaims = supportedClaims.filter((claim) => !claim.heading);
  const preservedHeadings = getPreservedHeadings(answerText);

  if (supportedEvidenceClaims.length === 0) {
    return "I do not have enough citation-backed evidence to answer reliably.";
  }

  const finalizedClaims = supportedEvidenceClaims
    .map((claim) =>
      formatSupportedClaim({
        claimText: claim.text,
        citations,
      })
    )
    .filter(Boolean);

  return [...preservedHeadings, ...finalizedClaims].join("\n");
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

  const normalizedClaimSupport = normalizeClaimSupportForHeadings(claimSupport);
  const unsupportedClaims = normalizedClaimSupport.claims.filter(
    (claim) => !claim.supported
  );
  const supportedEvidenceClaimCount = normalizedClaimSupport.claims.filter(
    (claim) => claim.supported && !claim.heading
  ).length;

  if (unsupportedClaims.length === 0) {
    if (
      normalizedClaimSupport.claims.length > 0 &&
      supportedEvidenceClaimCount === 0
    ) {
      return {
        text: buildFinalizedText({
          answerText: text,
          claimSupport: normalizedClaimSupport,
          citations,
        }),
        changed: true,
        abstained: true,
        removedClaims: [],
        claimSupport: normalizedClaimSupport,
      };
    }

    return {
      text,
      changed: false,
      abstained: false,
      removedClaims: [],
      claimSupport: normalizedClaimSupport,
    };
  }

  return {
    text: buildFinalizedText({
      answerText: text,
      claimSupport: normalizedClaimSupport,
      citations,
    }),
    changed: true,
    abstained: supportedEvidenceClaimCount === 0,
    removedClaims: unsupportedClaims.map((claim) => claim.text),
    claimSupport: normalizedClaimSupport,
  };
};
