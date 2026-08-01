import {
  CONTRAST_RELATION_PATTERN,
  NO_DIFFERENCE_RELATION_PATTERN,
} from "../rag/self-check/patterns.js";

export const SYNTHETIC_COMPARE_EXPECTATIONS = Object.freeze([
  "abstain",
  "difference",
  "no_difference",
]);

const getSupportedClaims = (claimSupport = {}) =>
  Array.isArray(claimSupport?.claims)
    ? claimSupport.claims.filter((claim) => claim?.supported === true)
    : [];

const isNoDifferenceClaim = (claim = {}) =>
  NO_DIFFERENCE_RELATION_PATTERN.test(String(claim?.text ?? ""));

const getSupportedDifferenceClaims = (claims = []) =>
  claims.filter(
    (claim) =>
      !isNoDifferenceClaim(claim) &&
      (claim?.section === "differences" ||
        (CONTRAST_RELATION_PATTERN.test(String(claim?.text ?? "")) &&
          new Set(claim?.supportedCitedDocIds ?? []).size >= 2))
  );

const getSupportedDifferenceDocumentIds = (claims = []) =>
  new Set(
    claims.flatMap((claim) =>
      Array.isArray(claim?.supportedCitedDocIds)
        ? claim.supportedCitedDocIds.filter(Boolean)
        : []
    )
  );

const groupSupportedDifferenceClaims = (claims = []) => {
  const groups = new Map();

  for (const claim of claims) {
    const key = claim?.sectionId ?? "legacy-differences";
    const group = groups.get(key) ?? [];

    group.push(claim);
    groups.set(key, group);
  }

  return [...groups.values()];
};

export const evaluateSyntheticComparisonExpectation = ({
  abstained = false,
  compareExpectation = null,
  claimSupport = null,
} = {}) => {
  const supportedClaims = getSupportedClaims(claimSupport);
  const supportedNoDifferenceClaims = supportedClaims.filter(isNoDifferenceClaim);
  const supportedDifferenceClaims = getSupportedDifferenceClaims(supportedClaims);
  const supportedDifferenceGroups = groupSupportedDifferenceClaims(
    supportedDifferenceClaims
  );
  const supportedDifferenceDocumentCount = Math.max(
    0,
    ...supportedDifferenceGroups.map(
      (claims) => getSupportedDifferenceDocumentIds(claims).size
    )
  );
  const hasSupportedCrossDocumentDifference =
    supportedDifferenceDocumentCount >= 2;

  if (compareExpectation === "no_difference") {
    const hasNoDifferenceVerdict = supportedNoDifferenceClaims.length > 0;
    const hasSubstantiveDifference = supportedDifferenceClaims.length > 0;
    const passed =
      !abstained && hasNoDifferenceVerdict && !hasSubstantiveDifference;

    return {
      checked: true,
      expected: compareExpectation,
      actual: abstained
        ? "abstain"
        : hasNoDifferenceVerdict && hasSubstantiveDifference
          ? "mixed"
          : hasNoDifferenceVerdict
          ? "no_difference"
          : "unresolved",
      passed,
      reasonCode: passed
        ? "ok"
        : abstained
          ? "unexpected_abstention"
          : hasSubstantiveDifference
            ? "supported_substantive_difference_present"
            : "missing_supported_no_difference_verdict",
      evidence: {
        supportedNoDifferenceClaimCount: supportedNoDifferenceClaims.length,
        supportedDifferenceClaimCount: supportedDifferenceClaims.length,
        supportedDifferenceDocumentCount,
      },
    };
  }

  if (compareExpectation === "difference") {
    const hasNoDifferenceVerdict = supportedNoDifferenceClaims.length > 0;
    const passed =
      !abstained &&
      !hasNoDifferenceVerdict &&
      hasSupportedCrossDocumentDifference;

    return {
      checked: true,
      expected: compareExpectation,
      actual: abstained
        ? "abstain"
        : hasNoDifferenceVerdict && hasSupportedCrossDocumentDifference
          ? "mixed"
          : hasSupportedCrossDocumentDifference
            ? "difference"
            : hasNoDifferenceVerdict
              ? "no_difference"
              : "unresolved",
      passed,
      reasonCode: passed
        ? "ok"
        : abstained
          ? "unexpected_abstention"
          : hasNoDifferenceVerdict
            ? "supported_no_difference_verdict_present"
            : "missing_supported_cross_document_difference",
      evidence: {
        supportedNoDifferenceClaimCount: supportedNoDifferenceClaims.length,
        supportedDifferenceClaimCount: supportedDifferenceClaims.length,
        supportedDifferenceDocumentCount,
      },
    };
  }

  if (compareExpectation === "abstain") {
    return {
      checked: true,
      expected: compareExpectation,
      actual: abstained ? "abstain" : "unresolved",
      passed: abstained,
      reasonCode: abstained ? "ok" : "missing_required_abstention",
      evidence: {
        supportedNoDifferenceClaimCount: supportedNoDifferenceClaims.length,
        supportedDifferenceClaimCount: supportedDifferenceClaims.length,
        supportedDifferenceDocumentCount,
      },
    };
  }

  return {
    checked: false,
    expected: compareExpectation,
    actual: abstained ? "abstain" : "unresolved",
    passed: true,
    reasonCode: "not_applicable",
    evidence: {
      supportedNoDifferenceClaimCount: supportedNoDifferenceClaims.length,
      supportedDifferenceClaimCount: supportedDifferenceClaims.length,
      supportedDifferenceDocumentCount,
    },
  };
};
