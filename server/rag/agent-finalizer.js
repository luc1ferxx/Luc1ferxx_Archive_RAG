import { evaluateClaimSupport } from "./agent-self-check.js";
import { filterCitationsToSourceRanks } from "./source-labels.js";
import { isStructuralSectionHeading } from "./self-check/attribution.js";
import { splitAnswerStructure } from "./self-check/claims.js";
import { normalizeStructuralClaimLabel } from "./self-check/text.js";

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
    .join(" ");

const stripSourceLabels = (value = "") =>
  String(value ?? "").replace(SOURCE_LABEL_PATTERN, "").trim();

const normalizeHeadingText = (value = "") => normalizeStructuralClaimLabel(value);

const isPreservedHeading = (value = "") =>
  isStructuralSectionHeading(normalizeHeadingText(value));

export const normalizeClaimSupportForHeadings = (claimSupport) => {
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

const formatSupportedClaim = ({ claim, citations }) => {
  const stripped = stripSourceLabels(claim.text)
    .replace(/^[-*]\s+/, "")
    .trim();

  if (!hasText(stripped)) {
    return "";
  }

  const sentence = ensureTerminalPunctuation(stripped);
  const verifiedSourceRanks = claim.supportedSourceRanks ?? [];
  const supportingCitations = filterCitationsToSourceRanks({
    sourceRanks: verifiedSourceRanks,
    citations,
  });
  const sourceLabelSuffix = buildSourceLabelSuffix(supportingCitations, citations);

  return sourceLabelSuffix ? `${sentence} ${sourceLabelSuffix}` : sentence;
};

const buildFinalizedText = ({ claimSupport, citations, nodes = [] }) => {
  const supportedClaims = claimSupport.claims.filter((claim) => claim.supported);
  const supportedEvidenceClaims = supportedClaims.filter((claim) => !claim.heading);
  const supportedDifferenceSectionIds = new Set(
    supportedEvidenceClaims
      .filter((claim) => claim.section === "differences")
      .map((claim) => claim.sectionId)
  );

  if (supportedEvidenceClaims.length === 0) {
    return "I do not have enough citation-backed evidence to answer reliably.";
  }

  if (nodes.length === 0) {
    return supportedEvidenceClaims
      .map((claim) => formatSupportedClaim({ claim, citations }))
      .filter(Boolean)
      .join("\n");
  }

  const finalizedLines = [];

  for (const node of nodes) {
    if (node.type === "heading") {
      if (
        node.section !== "differences" ||
        supportedDifferenceSectionIds.has(node.sectionId)
      ) {
        finalizedLines.push(node.text);
      }

      continue;
    }

    const claim = claimSupport.claims[node.claimIndex];

    if (!claim?.supported || claim.heading) {
      continue;
    }

    const formattedClaim = formatSupportedClaim({ claim, citations });

    if (formattedClaim) {
      finalizedLines.push(formattedClaim);
    }
  }

  return finalizedLines.join("\n");
};

export const finalizeAgentAnswer = ({
  answerText = "",
  citations = [],
  evidenceCitations = citations,
  comparisonAnalysisSummary = null,
} = {}) => {
  const text = String(answerText ?? "").trim();
  const claimSupport = evaluateClaimSupport({
    answerText: text,
    citations: evidenceCitations,
    comparisonAnalysisSummary,
  });
  const structure = splitAnswerStructure(text, evidenceCitations);

  if (!hasText(text) || citations.length === 0) {
    return {
      text,
      changed: false,
      abstained: false,
      removedClaims: [],
      claimSupport,
    };
  }

  if (!claimSupport.checked) {
    const containsOnlyHeadings =
      structure.nodes.length > 0 &&
      structure.claims.length === 0 &&
      structure.nodes.every((node) => node.type === "heading");

    return containsOnlyHeadings
      ? {
          text: "I do not have enough citation-backed evidence to answer reliably.",
          changed: true,
          abstained: true,
          removedClaims: [],
          claimSupport,
        }
      : {
          text,
          changed: false,
          abstained: false,
          removedClaims: [],
          claimSupport,
        };
  }

  const normalizedClaimSupport = normalizeClaimSupportForHeadings(claimSupport);
  const structureNodes =
    structure.claims.length === normalizedClaimSupport.claims.length
      ? structure.nodes
      : [];
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
          claimSupport: normalizedClaimSupport,
          citations,
          nodes: structureNodes,
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
      claimSupport: normalizedClaimSupport,
      citations,
      nodes: structureNodes,
    }),
    changed: true,
    abstained: supportedEvidenceClaimCount === 0,
    removedClaims: unsupportedClaims.map((claim) => claim.text),
    claimSupport: normalizedClaimSupport,
  };
};
