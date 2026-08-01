import {
  buildCitationSupportSegments,
  isStructuralSectionHeading,
} from "./self-check/attribution.js";
import { hasClaimPredicate } from "./self-check/claims.js";
import { evaluateClaimAgainstCitations } from "./self-check/support.js";

const LOGICAL_CONNECTOR_PATTERN =
  /\b(?:and|or|nor)\b|(?:以及|并且|或者|或是|和|与|且|或)/giu;
const SENTENCE_TERMINATOR_PATTERN = /[.!?。！？]\s*$/u;
const MARKDOWN_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+/u;
const TITLE_CASE_WORD_PATTERN = /^[\p{Lu}\d][\p{L}\p{N}'’/-]*$/u;
const TITLE_CASE_MINOR_WORDS = new Set([
  "and",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const normalizeLogicalConnector = (connector = "") => {
  const normalized = connector.toLocaleLowerCase();

  if (["or", "或者", "或是", "或"].includes(normalized)) {
    return "or";
  }
  if (normalized === "nor") {
    return "nor";
  }

  return "and";
};

const getLogicalConnectorSignature = (value = "") =>
  [...String(value ?? "").matchAll(LOGICAL_CONNECTOR_PATTERN)].map(
    ([connector]) => normalizeLogicalConnector(connector)
  );

const haveSameLogicalConnectors = (leftText = "", rightText = "") => {
  const leftConnectors = getLogicalConnectorSignature(leftText);
  const rightConnectors = getLogicalConnectorSignature(rightText);

  return (
    leftConnectors.length === rightConnectors.length &&
    leftConnectors.every(
      (connector, index) => connector === rightConnectors[index]
    )
  );
};

const isLikelyTitleHeading = (value = "", index = 0, segments = []) => {
  const words = String(value ?? "").trim().split(/\s+/u).filter(Boolean);

  return (
    index < segments.length - 1 &&
    words.length > 0 &&
    words.length <= 12 &&
    words.every(
      (word) =>
        TITLE_CASE_WORD_PATTERN.test(word) ||
        TITLE_CASE_MINOR_WORDS.has(word.toLocaleLowerCase())
    )
  );
};

const isStructuralEvidenceSegment = (value = "", index = 0, segments = []) =>
  isStructuralSectionHeading(value) ||
  MARKDOWN_HEADING_PATTERN.test(value) ||
  (!hasClaimPredicate(value) &&
    !SENTENCE_TERMINATOR_PATTERN.test(value) &&
    isLikelyTitleHeading(value, index, segments));

const buildProvableEvidenceSegments = (evidenceText = "") => {
  const segments = buildCitationSupportSegments([{ evidenceText }], {
    includeParentSentences: false,
  });

  return segments.filter(
    (segment, index) =>
      !isStructuralEvidenceSegment(segment, index, segments)
  );
};

const isSegmentEntailedBy = ({ claimSegment = "", supportSegment = "" } = {}) =>
  haveSameLogicalConnectors(claimSegment, supportSegment) &&
  evaluateClaimAgainstCitations({
    claimText: claimSegment,
    citations: [{ evidenceText: supportSegment }],
  }).supported;

const isEvidenceEntailedBy = ({ claimText = "", supportText = "" } = {}) => {
  const claims = buildProvableEvidenceSegments(claimText);
  const supportSegments = buildProvableEvidenceSegments(supportText);

  if (claims.length === 0 || supportSegments.length === 0) {
    return false;
  }

  return claims.every((claimSegment) =>
    supportSegments.some((supportSegment) =>
      isSegmentEntailedBy({ claimSegment, supportSegment })
    )
  );
};

export const evaluateBidirectionalEvidenceEntailment = ({
  leftText = "",
  rightText = "",
} = {}) => ({
  leftEntailedByRight: isEvidenceEntailedBy({
    claimText: leftText,
    supportText: rightText,
  }),
  rightEntailedByLeft: isEvidenceEntailedBy({
    claimText: rightText,
    supportText: leftText,
  }),
});
