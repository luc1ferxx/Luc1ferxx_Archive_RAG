import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import {
  CHINESE_MODALITY_SURFACE_PATTERN,
  CLAIM_LEAD_LABEL_PATTERN,
  DOTTED_ABBREVIATION_PATTERN,
  FACT_TERM_ALIASES,
  GROUPED_SOURCE_LABEL_PATTERN,
  NEGATIVE_POLARITY_PATTERN,
  NUMBER_PATTERN,
  NUMERIC_CONSTRAINT_PATTERNS,
  REPORTIVE_STATED_WRAPPER_PATTERN,
  SOURCE_LABEL_PATTERN,
  SOURCE_LABEL_CAPTURE_PATTERN,
} from "./patterns.js";

export const normalizeEvidenceText = (value) => String(value ?? "").trim();

export const uniqueValues = (values = []) => [...new Set(values.filter(Boolean))];

export const canonicalizeFactTerm = (term = "") => FACT_TERM_ALIASES.get(term) ?? term;

export const normalizeDottedAbbreviationsForTokens = (value = "") =>
  String(value ?? "").replace(DOTTED_ABBREVIATION_PATTERN, (match) =>
    match.replaceAll(".", "")
  );

export const normalizeReportiveWrappersForTokens = (value = "") =>
  String(value ?? "").replace(
    REPORTIVE_STATED_WRAPPER_PATTERN,
    "$1 to be"
  );

export const extractFactTerms = (value = "") =>
  uniqueValues(
    extractMeaningfulTokens(
      normalizeReportiveWrappersForTokens(
        normalizeDottedAbbreviationsForTokens(value)
      )
    ).map(canonicalizeFactTerm)
  );

export const stripSourceLabels = (value = "") =>
  String(value ?? "").replace(SOURCE_LABEL_PATTERN, "").trim();

export const stripClaimLeadLabel = (value = "") =>
  stripSourceLabels(value)
    .replace(/^[-*]\s+/, "")
    .replace(CLAIM_LEAD_LABEL_PATTERN, "")
    .trim();

export const extractSourceRanks = (value = "") =>
  uniqueValues(
    [...String(value ?? "").matchAll(SOURCE_LABEL_CAPTURE_PATTERN)].map(
      (match) => Number(match[1])
    )
  ).filter((rank) => Number.isInteger(rank) && rank > 0);

export const normalizeGroupedSourceLabels = (value = "") =>
  String(value ?? "").replace(GROUPED_SOURCE_LABEL_PATTERN, (group) =>
    [...group.matchAll(/(?:source|来源)\s*(\d+)/gi)]
      .map((match) => `[Source ${match[1]}]`)
      .join(" ")
  );

export const normalizeNumericAnchor = (value = "") => {
  const compact = String(value ?? "")
    .replace(/,/g, "")
    .replace(/^([+-]?)\$/, "$1")
    .trim();
  const percentage = compact.endsWith("%");
  const numericValue = Number(percentage ? compact.slice(0, -1) : compact);

  return Number.isFinite(numericValue)
    ? `${numericValue}${percentage ? "%" : ""}`
    : compact.toLowerCase();
};

export const normalizeNumericConstraint = (value = "") => {
  const compact = String(value ?? "")
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const numbers = compact.match(/\$?\d+(?:\.\d+)?%?/g) ?? [];
  const normalizedNumbers = numbers.map(normalizeNumericAnchor);

  if (/^(?:at least|minimum(?: of)?|no fewer than)\b/.test(compact)) {
    return `gte:${normalizedNumbers[0] ?? ""}`;
  }
  if (/^(?:up to|at most|maximum(?: of)?|no more than)\b/.test(compact)) {
    return `lte:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith(">=")) {
    return `gte:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith("<=")) {
    return `lte:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith(">")) {
    return `gt:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith("<")) {
    return `lt:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith("±")) {
    return `plusminus:${normalizedNumbers[0] ?? ""}`;
  }
  if (normalizedNumbers.length === 2) {
    return `range:${normalizedNumbers.join(":")}`;
  }

  return compact;
};

export const extractNumericConstraintTexts = (value = "") =>
  uniqueValues(
    NUMERIC_CONSTRAINT_PATTERNS.flatMap((pattern) => {
      pattern.lastIndex = 0;
      const matches = String(value ?? "").match(pattern) ?? [];
      pattern.lastIndex = 0;
      return matches;
    })
  );

export const includesNormalizedPhrase = (text = "", phrase = "") =>
  (() => {
    const normalizedText = normalizeSearchText(text);
    const normalizedPhrase = normalizeSearchText(phrase);

    if (!normalizedPhrase) {
      return false;
    }

    if (/[一-鿿]/.test(normalizedPhrase)) {
      return normalizedText
        .replace(/\s+/g, "")
        .includes(normalizedPhrase.replace(/\s+/g, ""));
    }

    return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
  })();

export const getChineseModalitySurfaceTerms = (value = "") => {
  CHINESE_MODALITY_SURFACE_PATTERN.lastIndex = 0;
  const matches = String(value ?? "").match(CHINESE_MODALITY_SURFACE_PATTERN) ?? [];
  CHINESE_MODALITY_SURFACE_PATTERN.lastIndex = 0;

  return new Set(matches.flatMap((match) => extractMeaningfulTokens(match)));
};

export const hasNegativePolarity = (value = "") =>
  NEGATIVE_POLARITY_PATTERN.test(String(value ?? ""));

export const getTokenOverlap = ({ claimTerms, supportTerms }) => {
  if (claimTerms.length === 0) {
    return 1;
  }

  const matchedTerms = claimTerms.filter((term) => supportTerms.has(term));

  return Number((matchedTerms.length / claimTerms.length).toFixed(4));
};

export const haveSameValues = (leftValues = [], rightValues = []) => {
  const left = new Set(leftValues);
  const right = new Set(rightValues);

  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
};

export const normalizeStructuralClaimLabel = (value = "") =>
  stripSourceLabels(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/[:：]\s*$/, "")
    .trim();

export const isAnchorSupported = ({ anchor, rawSupportText = "" } = {}) => {
  if (anchor.type === "numeric_constraint") {
    return extractNumericConstraintTexts(rawSupportText).some(
      (candidate) =>
        normalizeNumericConstraint(candidate) === anchor.normalized
    );
  }

  if (anchor.type === "number") {
    return (rawSupportText.match(NUMBER_PATTERN) ?? []).some(
      (candidate) =>
        normalizeNumericAnchor(candidate) === normalizeNumericAnchor(anchor.text)
    );
  }

  return includesNormalizedPhrase(rawSupportText, anchor.normalized);
};
