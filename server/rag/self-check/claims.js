import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import {
  CLAIM_PREDICATE_PATTERN,
  CLAIM_SPLIT_PATTERN,
  CODE_PATTERN,
  COMPARISON_SCAFFOLD_TERMS,
  DATE_PATTERN,
  DOCUMENT_ATTRIBUTION_PREPOSITIONS,
  DOCUMENT_IDENTITY_TERMS,
  MODALITY_CLAIM_TERMS,
  MONTH_PATTERN,
  PROTECTED_PERIOD,
  SOURCE_AFTER_PUNCTUATION_PATTERN,
  DOTTED_ABBREVIATION_PATTERN,
} from "./patterns.js";
import {
  extractFactTerms,
  extractNumericOccurrences,
  extractSourceRanks,
  normalizeGroupedSourceLabels,
  normalizeNumericSyntax,
  normalizeStructuralClaimLabel,
  stripClaimLeadLabel,
  stripSourceLabels,
  uniqueValues,
} from "./text.js";
import {
  getDocumentAttributionTerms,
  getGenericDocumentAttributionTerms,
  isStructuralClaimLabel,
  isStructuralSectionHeading,
} from "./attribution.js";

export const hasClaimPredicate = (value = "") =>
  CLAIM_PREDICATE_PATTERN.test(stripSourceLabels(value));

export const extractClaimAnchors = (claimText = "") => {
  const normalizedNumericText = normalizeNumericSyntax(claimText);
  const numericAnchors = extractNumericOccurrences(normalizedNumericText).map(
    (occurrence, occurrenceIndex) => ({
      occurrenceIndex,
      text: occurrence.text,
      type: occurrence.type,
      normalized: occurrence.normalized,
    })
  );
  const nonNumericAnchors = [
    ...(normalizedNumericText.match(MONTH_PATTERN) ?? []).map((text) => ({
      text,
      type: "month",
    })),
    ...(normalizedNumericText.match(DATE_PATTERN) ?? []).map((text) => ({
      text,
      type: "date",
    })),
    ...(normalizedNumericText.match(CODE_PATTERN) ?? []).map((text) => ({
      text,
      type: "code",
    })),
  ].reduce((anchors, anchor) => {
    const normalized = normalizeSearchText(anchor.text);
    const key = `${anchor.type}:${normalized}`;

    if (!anchors.has(key)) {
      anchors.set(key, {
        ...anchor,
        normalized,
      });
    }

    return anchors;
  }, new Map()).values();

  return [...numericAnchors, ...nonNumericAnchors];
};

export const getClaimAnchors = (claimText = "") => [
  ...extractClaimAnchors(claimText),
];

export const splitCoordinatedClaim = (value = "") => {
  const parts = String(value ?? "").split(/\s+\band\b\s+/i);

  if (parts.length < 2) {
    return [value];
  }

  const claims = [];
  let current = parts[0];

  for (const part of parts.slice(1)) {
    if (hasClaimPredicate(current) && hasClaimPredicate(part)) {
      claims.push(current);
      current = part;
      continue;
    }

    current = `${current} and ${part}`;
  }

  claims.push(current);
  return claims;
};

export const moveTrailingSourceLabelsBeforePunctuation = (value = "") =>
  String(value ?? "").replace(
    SOURCE_AFTER_PUNCTUATION_PATTERN,
    (_match, punctuation, labels) => `${labels.trim()}${punctuation} `
  );

export const protectDottedAbbreviations = (value = "") =>
  String(value ?? "").replace(DOTTED_ABBREVIATION_PATTERN, (match) =>
    match.replaceAll(".", PROTECTED_PERIOD)
  );

export const restoreProtectedPeriods = (value = "") =>
  String(value ?? "").replaceAll(PROTECTED_PERIOD, ".");

export const splitAnswerStructure = (answerText = "", citations = []) => {
  let currentSection = "";
  let currentSectionDepth = 0;
  let currentSectionId = null;
  let currentSectionLabel = "";
  let nextSectionId = 1;
  const rawNodes = [];

  for (const line of String(answerText ?? "").split(/\n+/g)) {
    if (isStructuralSectionHeading(line)) {
      const headingLabel = normalizeStructuralClaimLabel(line);
      const normalizedSectionLabel = normalizeSearchText(headingLabel);
      const markdownHeading = String(line ?? "").match(/^\s*(#{1,6})\s+/);
      const headingDepth = markdownHeading?.[1]?.length ?? 0;
      const listHeading = /^\s*[-*+]\s+/.test(String(line ?? ""));
      const nestedDifferenceHeading =
        currentSection === "differences" &&
        (headingDepth > currentSectionDepth || listHeading);

      if (nestedDifferenceHeading) {
        rawNodes.push({
          type: "heading",
          text: headingLabel,
          section: currentSection,
          sectionId: currentSectionId,
        });
        continue;
      }

      currentSection = /^(?:differences?|差异)$/.test(
        normalizedSectionLabel
      )
        ? "differences"
        : normalizedSectionLabel;
      currentSectionDepth = headingDepth;
      currentSectionId = nextSectionId;
      currentSectionLabel = headingLabel;
      nextSectionId += 1;
      rawNodes.push({
        type: "heading",
        text: headingLabel,
        section: currentSection,
        sectionId: currentSectionId,
      });
      continue;
    }

    if (isStructuralClaimLabel({ value: line, citations })) {
      continue;
    }

    const protectedLine = moveTrailingSourceLabelsBeforePunctuation(
      protectDottedAbbreviations(
        normalizeGroupedSourceLabels(line).replace(
          /\bvs\./gi,
          `vs${PROTECTED_PERIOD}`
        )
      )
    );

    for (const rawClaim of protectedLine.split(CLAIM_SPLIT_PATTERN)) {
      const sourceRanks = extractSourceRanks(rawClaim);

      for (const coordinatedClaim of splitCoordinatedClaim(rawClaim)) {
        rawNodes.push({
          type: "raw_claim",
          rawText: restoreProtectedPeriods(coordinatedClaim).trim(),
          section: currentSection,
          sectionId: currentSectionId,
          sectionLabel: currentSectionLabel,
          sourceRanks,
        });
      }
    }
  }

  const claims = [];
  const nodes = [];

  for (const node of rawNodes) {
    if (node.type === "heading") {
      nodes.push(node);
      continue;
    }

    if (isStructuralClaimLabel({ value: node.rawText, citations })) {
      continue;
    }

    const claim = {
      text: stripSourceLabels(node.rawText)
        .replace(/[.!?。！？]+$/g, "")
        .trim(),
      section: node.section,
      sectionId: node.sectionId,
      sectionLabel: node.sectionLabel,
      sourceRanks: node.sourceRanks,
    };
    const meaningfulTermCount = extractMeaningfulTokens(claim.text).length;

    if (
      !claim.text ||
      (meaningfulTermCount < 1 &&
        getClaimAnchors(claim.text).length === 0 &&
        claim.sourceRanks.length === 0)
    ) {
      continue;
    }

    const claimIndex = claims.length;

    claims.push(claim);
    nodes.push({
      type: "claim",
      claimIndex,
      section: claim.section,
      sectionId: claim.sectionId,
    });
  }

  return { claims, nodes };
};

export const splitAnswerClaims = (answerText = "", citations = []) =>
  splitAnswerStructure(answerText, citations).claims;

export const getClaimBindingTerms = ({
  claimText = "",
  documentAttributionTerms = new Set(),
  forceComparisonClaim = false,
} = {}) => {
  if (forceComparisonClaim) {
    return [];
  }

  const factualClaim = stripClaimLeadLabel(claimText);
  const predicateMatch = CLAIM_PREDICATE_PATTERN.exec(factualClaim);

  if (!predicateMatch || predicateMatch.index === 0) {
    return [];
  }

  const genericDocumentAttributionTerms = getGenericDocumentAttributionTerms(
    factualClaim
  );

  return uniqueValues(
    extractFactTerms(factualClaim.slice(0, predicateMatch.index))
  ).filter(
    (term) =>
      !documentAttributionTerms.has(term) &&
      !genericDocumentAttributionTerms.has(term) &&
      !DOCUMENT_IDENTITY_TERMS.has(term) &&
      !DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term)
  );
};

export const getAdditiveDetailTermGroups = ({
  claimText = "",
  documentAttributionTerms = new Set(),
} = {}) =>
  [
    ...String(claimText ?? "").matchAll(
      /\b(?:and|with|plus|including|along with|as well as)\b\s+([^,;.!?。！？]+)/gi
    ),
  ]
    .map((match) =>
      uniqueValues(extractMeaningfulTokens(match[1])).filter(
        (term) =>
          !documentAttributionTerms.has(term) &&
          !COMPARISON_SCAFFOLD_TERMS.has(term) &&
          !MODALITY_CLAIM_TERMS.has(term)
      )
    )
    .filter((terms) => terms.length > 0);
