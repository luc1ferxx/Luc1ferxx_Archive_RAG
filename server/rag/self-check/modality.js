import { extractMeaningfulTokens } from "../text-utils.js";
import {
  ALLOW_MODALITY_PATTERN,
  CLAIM_PREDICATE_PATTERN,
  COMPARISON_SCAFFOLD_TERMS,
  DOUBLE_NEGATIVE_REQUIREMENT_PATTERN,
  MODALITY_CLAIM_TERMS,
  MODALITY_CLAUSE_SPLIT_PATTERN,
  NEGATED_PERMISSION_PATTERN,
  NEGATED_PROHIBITION_PATTERN,
  NEGATED_REQUIREMENT_PATTERN,
  PROHIBIT_MODALITY_PATTERN,
  RECOMMEND_MODALITY_PATTERN,
  REQUIRE_MODALITY_PATTERN,
} from "./patterns.js";
import { normalizeSemanticText, uniqueValues } from "./text.js";

const PROTECTED_NUMERIC_RANGE_AND = "\uE001";
const NUMERIC_ATOM_SOURCE = "[+-]?\\$?\\d+(?:,\\d{3})*(?:\\.\\d+)?%?";
const NUMERIC_RANGE_AND_PATTERN = new RegExp(
  `(\\b(?:between|from)\\s+${NUMERIC_ATOM_SOURCE})\\s+and\\s+(${NUMERIC_ATOM_SOURCE})`,
  "gi"
);

export const getModalityLabels = (value = "") => {
  const text = normalizeSemanticText(value);
  const labels = [];
  const negatedPermission = NEGATED_PERMISSION_PATTERN.test(text);
  const negatedRequirement = NEGATED_REQUIREMENT_PATTERN.test(text);
  const negatedProhibition = NEGATED_PROHIBITION_PATTERN.test(text);
  const doubleNegativeRequirement = DOUBLE_NEGATIVE_REQUIREMENT_PATTERN.test(
    text
  );
  NEGATED_PERMISSION_PATTERN.lastIndex = 0;
  NEGATED_REQUIREMENT_PATTERN.lastIndex = 0;

  if (
    negatedProhibition ||
    ALLOW_MODALITY_PATTERN.test(text.replace(NEGATED_PERMISSION_PATTERN, ""))
  ) {
    labels.push("allow");
  }
  NEGATED_PERMISSION_PATTERN.lastIndex = 0;

  if (
    !negatedProhibition &&
    (negatedPermission || PROHIBIT_MODALITY_PATTERN.test(text))
  ) {
    labels.push("prohibit");
  }

  if (
    doubleNegativeRequirement ||
    REQUIRE_MODALITY_PATTERN.test(
      text.replace(NEGATED_REQUIREMENT_PATTERN, "")
    )
  ) {
    labels.push("require");
  }
  NEGATED_REQUIREMENT_PATTERN.lastIndex = 0;

  if (negatedRequirement && !doubleNegativeRequirement) {
    labels.push("optional");
  }

  if (RECOMMEND_MODALITY_PATTERN.test(text)) {
    labels.push("recommend");
  }

  return labels;
};

const splitCoordinatedClauses = (value = "") => {
  const protectedValue = String(value ?? "").replace(
    NUMERIC_RANGE_AND_PATTERN,
    `$1 ${PROTECTED_NUMERIC_RANGE_AND} $2`
  );
  const parts = protectedValue.split(
    /(\s*(?:[,，]\s*)?\b(?:and|as\s+well\s+as|followed\s+by|plus|then)\b\s*)/gi
  );
  const clauses = [];
  let current = parts[0] ?? "";

  for (let index = 1; index < parts.length; index += 2) {
    const separator = parts[index] ?? " and ";
    const next = parts[index + 1] ?? "";
    const numericRespectivelyList =
      /\band\b/i.test(separator) &&
      /\d/.test(current) &&
      /\d/.test(next) &&
      /\brespectively\b/i.test(protectedValue);
    const separatesIndependentClauses =
      CLAIM_PREDICATE_PATTERN.test(current) &&
      (CLAIM_PREDICATE_PATTERN.test(next) || /\d/.test(next)) &&
      !numericRespectivelyList;

    if (separatesIndependentClauses) {
      clauses.push(current);
      current = next;
      continue;
    }

    current = `${current}${separator}${next}`;
  }

  clauses.push(current);
  return clauses.map((clause) =>
    clause.replaceAll(PROTECTED_NUMERIC_RANGE_AND, "and")
  );
};

const splitPredicateDelimitedClauses = (value = "") => {
  const parts = String(value ?? "").split(
    /(\s*(?:[,，:/]|[—–])\s*)/g
  );
  const clauses = [];
  let current = parts[0] ?? "";

  for (let index = 1; index < parts.length; index += 2) {
    const separator = parts[index] ?? " ";
    const next = parts[index + 1] ?? "";

    if (
      CLAIM_PREDICATE_PATTERN.test(current) &&
      CLAIM_PREDICATE_PATTERN.test(next)
    ) {
      clauses.push(current);
      current = next;
      continue;
    }

    current = `${current}${separator}${next}`;
  }

  clauses.push(current);
  return clauses;
};

export const splitModalityClauses = (value = "") =>
  normalizeSemanticText(value)
    .split(MODALITY_CLAUSE_SPLIT_PATTERN)
    .flatMap(splitPredicateDelimitedClauses)
    .flatMap(splitCoordinatedClauses)
    .map((clause) => clause.trim())
    .filter(Boolean);

export const getModalityClaimTerms = ({
  claimText = "",
  anchor,
  documentAttributionTerms = new Set(),
} = {}) => {
  const matchingClauses = splitModalityClauses(claimText).filter((clause) =>
    getModalityLabels(clause).includes(anchor)
  );
  const scopedText = matchingClauses.length > 0
    ? matchingClauses.join(" ")
    : claimText;

  return uniqueValues(extractMeaningfulTokens(scopedText)).filter(
    (term) =>
      !MODALITY_CLAIM_TERMS.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term) &&
      !documentAttributionTerms.has(term)
  );
};
