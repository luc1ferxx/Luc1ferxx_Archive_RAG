import { extractMeaningfulTokens } from "../text-utils.js";
import {
  ALLOW_MODALITY_PATTERN,
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
import { uniqueValues } from "./text.js";

export const getModalityLabels = (value = "") => {
  const text = String(value ?? "");
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

export const splitModalityClauses = (value = "") =>
  String(value ?? "")
    .split(MODALITY_CLAUSE_SPLIT_PATTERN)
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
