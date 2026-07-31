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
  NUMBER_PATTERN,
  PROTECTED_PERIOD,
  SOURCE_AFTER_PUNCTUATION_PATTERN,
  DOTTED_ABBREVIATION_PATTERN,
} from "./patterns.js";
import {
  extractFactTerms,
  extractNumericConstraintTexts,
  extractSourceRanks,
  normalizeGroupedSourceLabels,
  normalizeNumericConstraint,
  stripClaimLeadLabel,
  stripSourceLabels,
  uniqueValues,
} from "./text.js";
import {
  getDocumentAttributionTerms,
  getGenericDocumentAttributionTerms,
  isStructuralClaimLabel,
} from "./attribution.js";

export const hasClaimPredicate = (value = "") =>
  CLAIM_PREDICATE_PATTERN.test(stripSourceLabels(value));

export const extractClaimAnchors = (claimText = "") =>
  Array.from([
    ...extractNumericConstraintTexts(claimText).map((text) => ({
      text,
      type: "numeric_constraint",
    })),
    ...(claimText.match(NUMBER_PATTERN) ?? []).map((text) => ({
      text,
      type: "number",
    })),
    ...(claimText.match(MONTH_PATTERN) ?? []).map((text) => ({
      text,
      type: "month",
    })),
    ...(claimText.match(DATE_PATTERN) ?? []).map((text) => ({
      text,
      type: "date",
    })),
    ...(claimText.match(CODE_PATTERN) ?? []).map((text) => ({
      text,
      type: "code",
    })),
  ].reduce((anchors, anchor) => {
    const normalized =
      anchor.type === "numeric_constraint"
        ? normalizeNumericConstraint(anchor.text)
        : normalizeSearchText(anchor.text);
    const key = `${anchor.type}:${normalized}`;

    if (!anchors.has(key)) {
      anchors.set(key, {
        ...anchor,
        normalized,
      });
    }

    return anchors;
  }, new Map()).values());

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

export const splitAnswerClaims = (answerText = "", citations = []) =>
  String(answerText ?? "")
    .split(/\n+/g)
    .flatMap((line) => {
      const protectedLine = moveTrailingSourceLabelsBeforePunctuation(
        protectDottedAbbreviations(
          normalizeGroupedSourceLabels(line).replace(
            /\bvs\./gi,
            `vs${PROTECTED_PERIOD}`
          )
        )
      );

      return protectedLine
        .split(CLAIM_SPLIT_PATTERN)
        .flatMap((claim) => {
          const sourceRanks = extractSourceRanks(claim);

          return splitCoordinatedClaim(claim).map((coordinatedClaim) => ({
            rawText: restoreProtectedPeriods(coordinatedClaim).trim(),
            sourceRanks,
          }));
        });
    })
    .filter(
      (claim) =>
        !isStructuralClaimLabel({ value: claim.rawText, citations })
    )
    .map((claim) => ({
      text: stripSourceLabels(claim.rawText)
        .replace(/[.!?。！？]+$/g, "")
        .trim(),
      sourceRanks: claim.sourceRanks,
    }))
    .filter((claim) => {
      const meaningfulTermCount = extractMeaningfulTokens(claim.text).length;

      return Boolean(
        claim.text &&
          (meaningfulTermCount >= 1 ||
            getClaimAnchors(claim.text).length > 0 ||
            claim.sourceRanks.length > 0)
      );
    });

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
