import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import { filterCitationsToSourceRanks } from "../source-labels.js";
import {
  BARE_BOTH_AGREEMENT_PATTERN,
  CHECKABLE_CITATION_FIELDS,
  CLAIM_PREDICATE_PATTERN,
  COMPARISON_RELATION_PATTERN,
  COMPARISON_SCAFFOLD_TERMS,
  CONTRAST_RELATION_PATTERN,
  CONTRAST_STYLE_TERMS,
  DOCUMENT_ATTRIBUTION_PREPOSITIONS,
  DOCUMENT_ATTRIBUTION_VERBS,
  DOCUMENT_IDENTITY_TERMS,
  EITHER_DOCUMENT_RELATION_PATTERN,
  AGREEMENT_RELATION_PATTERN,
  EXCLUSIVE_RELATION_PATTERN,
  GENERIC_EXCLUSIVE_DOCUMENT_PATTERN,
  MODALITY_CLAIM_TERMS,
  NUMERIC_CONSTRAINT_SURFACE_TERMS,
  NO_DIFFERENCE_RELATION_PATTERN,
  EVIDENCE_SCOPED_NO_DIFFERENCE_PATTERN,
  SOURCE_SCOPED_EXCLUSIVE_PATTERN,
  SUPPORT_TOKEN_OVERLAP_THRESHOLD,
} from "./patterns.js";
import {
  extractFactTerms,
  extractDateValues,
  extractOrderedFactTerms,
  extractNumericOccurrences,
  getChineseModalitySurfaceTerms,
  getTokenOverlap,
  hasNegativePolarity,
  haveSameValues,
  includesNormalizedPhrase,
  isAnchorSupported,
  isRefutedQuotedClaim,
  normalizeEvidenceText,
  normalizeNumericAnchor,
  normalizeSemanticText,
  stripNumericValueSurfaces,
  stripClaimLeadLabel,
  uniqueValues,
} from "./text.js";
import { getModalityLabels, splitModalityClauses } from "./modality.js";
import {
  buildNumericOccurrenceFacts,
  haveSameNumericOccurrences,
  NUMERIC_MEASUREMENT_TERMS,
} from "./numeric-facts.js";
import {
  buildCitationSupportSegments,
  buildCitationSupportSentences,
  getCitationDocIds,
  getCitationDocumentAliases,
  getCitationDocumentAliasEntries,
  getCitationIdentity,
  getCitationSourceRank,
  getDocumentAttributionTerms,
  getExplicitlyAttributedCitationIdentities,
  getGenericDocumentAttributionTerms,
  getGroupDocumentAliases,
  getMetadataFactAnchors,
  groupCitationsByDocument,
} from "./attribution.js";
import {
  extractClaimAnchors,
  getAdditiveDetailTermGroups,
  getClaimBindingTerms,
} from "./claims.js";
import {
  areCopularRelationsSupported,
  hasReversedTermOrder,
} from "./relation-order.js";
import {
  getDocumentRelationCardinality,
  normalizeDocumentReportiveClaim,
} from "./reportive-claims.js";

const MAX_NUMERIC_OCCURRENCES_PER_CLAIM = 128;

const normalizeExactEvidenceMatchText = (value = "") =>
  normalizeEvidenceText(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?。！？]+$/u, "")
    .toLocaleLowerCase();

const normalizeRelationOperators = (value = "") =>
  String(value ?? "")
    .replace(/(?:>=|≥|≧)/g, " greater than or equal to ")
    .replace(/(?:<=|≤|≦)/g, " less than or equal to ")
    .replace(/>/g, " greater than ")
    .replace(/</g, " less than ");

const getRelationOrderTerms = (value = "") => {
  const hasNumericValue = extractNumericOccurrences(value).length > 0;

  return extractOrderedFactTerms(
    stripNumericValueSurfaces(normalizeRelationOperators(value))
  ).filter(
    (term) =>
      !COMPARISON_SCAFFOLD_TERMS.has(term) &&
      !DOCUMENT_IDENTITY_TERMS.has(term) &&
      (!hasNumericValue || !NUMERIC_CONSTRAINT_SURFACE_TERMS.has(term)) &&
      !NUMERIC_MEASUREMENT_TERMS.has(term)
  );
};

const COMPARATOR_RELATION_TERMS = new Set([
  "above",
  "below",
  "equal",
  "greater",
  "less",
  "lower",
  "over",
  "under",
]);

const getLikelyRelationPivotTerms = (value = "", orderedTerms = []) => {
  const predicatePattern = new RegExp(CLAIM_PREDICATE_PATTERN.source, "gi");
  const explicitPredicates = extractFactTerms(
    (String(value ?? "").match(predicatePattern) ?? []).join(" ")
  ).filter((term) => orderedTerms.includes(term));

  if (explicitPredicates.length > 0) {
    return new Set(explicitPredicates);
  }

  const comparators = orderedTerms.filter((term) =>
    COMPARATOR_RELATION_TERMS.has(term)
  );

  if (comparators.length > 0) {
    return new Set(comparators);
  }

  const inferredPredicate = orderedTerms.find(
    (term, index) =>
      index > 0 &&
      index < orderedTerms.length - 1 &&
      /^[a-z][a-z-]{2,}(?:ed|ing|s)$/i.test(term)
  );

  return new Set(inferredPredicate ? [inferredPredicate] : []);
};

const hasReversedRelationTerms = (claimText = "", supportText = "") => {
  const claimTerms = getRelationOrderTerms(claimText);
  const supportTerms = getRelationOrderTerms(supportText);

  return hasReversedTermOrder(claimTerms, supportTerms, {
    pivotTerms: getLikelyRelationPivotTerms(claimText, claimTerms),
  });
};

export const buildClaimTerms = ({
  claimText,
  scopedCitations,
  documentLabelCitations = scopedCitations,
  forceComparisonClaim = false,
  supportTerms,
}) => {
  const factualClaimText = stripClaimLeadLabel(claimText);
  const citedDocCount = getCitationDocIds(scopedCitations).size;
  const mentionedDocCount = new Set(
    documentLabelCitations
      .filter((citation) =>
        getCitationDocumentAliases(citation).some((alias) =>
          includesNormalizedPhrase(factualClaimText, alias)
        )
      )
      .map((citation) => getCitationIdentity(citation))
  ).size;
  const comparisonClaim =
    forceComparisonClaim ||
    EITHER_DOCUMENT_RELATION_PATTERN.test(factualClaimText) ||
    (citedDocCount > 1 &&
      (COMPARISON_RELATION_PATTERN.test(factualClaimText) || mentionedDocCount > 1));
  const documentAttributionTerms = getDocumentAttributionTerms({
    claimText: factualClaimText,
    citations: documentLabelCitations,
    forceComparisonClaim: comparisonClaim,
  });
  const genericDocumentAttributionTerms = getGenericDocumentAttributionTerms(
    factualClaimText
  );
  const chineseModalitySurfaceTerms = getChineseModalitySurfaceTerms(
    factualClaimText
  );
  const hasNumericConstraint = extractClaimAnchors(factualClaimText).some(
    (anchor) => anchor.type === "numeric_constraint"
  );

  return extractFactTerms(stripNumericValueSurfaces(factualClaimText)).filter((term) => {
    if (
      documentAttributionTerms.has(term) ||
      genericDocumentAttributionTerms.has(term)
    ) {
      return false;
    }

    if (
      (MODALITY_CLAIM_TERMS.has(term) ||
        chineseModalitySurfaceTerms.has(term)) &&
      getModalityLabels(factualClaimText).length > 0
    ) {
      return false;
    }

    if (
      documentAttributionTerms.size > 0 &&
      DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(term)
    ) {
      return false;
    }

    if (hasNumericConstraint && NUMERIC_CONSTRAINT_SURFACE_TERMS.has(term)) {
      return false;
    }

    return !(
      comparisonClaim &&
      !supportTerms.has(term) &&
      COMPARISON_SCAFFOLD_TERMS.has(term)
    );
  });
};

const getNumericAnchorBindingGroups = ({
  anchor,
  claimText = "",
  documentAttributionTerms = new Set(),
} = {}) =>
  splitNumericFactClauses(claimText)
    .filter((clause) =>
      extractClaimAnchors(clause).some(
        (candidate) =>
          candidate.type === anchor.type &&
          candidate.normalized === anchor.normalized
      )
    )
    .flatMap((clause) => {
      const factualClause = stripClaimLeadLabel(clause);
      const bindingTerms = getNumericClauseBindingTerms({
        clause: factualClause,
        documentAttributionTerms,
      });
      const predicateMatch = CLAIM_PREDICATE_PATTERN.exec(factualClause);
      const subjectPrefix = predicateMatch
        ? factualClause.slice(0, predicateMatch.index)
        : "";
      const subjectParts = /\band\b/i.test(subjectPrefix)
        ? subjectPrefix
            .split(/\s*(?:[,，]|\band\b)\s*/i)
            .map((part) =>
              getNumericClauseBindingTerms({
                clause: part,
                documentAttributionTerms,
              })
            )
            .filter((terms) => terms.length > 0)
        : [];
      const allSubjectTerms = new Set(subjectParts.flat());
      const sharedBindingTerms = bindingTerms.filter(
        (term) => !allSubjectTerms.has(term)
      );
      const bindingGroups =
        subjectParts.length > 1
          ? subjectParts.map((terms) =>
              uniqueValues([...terms, ...sharedBindingTerms])
            )
          : [bindingTerms];

      return bindingGroups.map((groupBindingTerms) => ({
        bindingTerms: groupBindingTerms,
        clause: factualClause,
        modalityAnchors: getModalityLabels(factualClause),
      }));
    });

const NUMERIC_DOCUMENT_WRAPPER_TERMS = new Set([
  "cited",
  "quoted",
  "retrieved",
  "selected",
]);

const getNumericClauseBindingTerms = ({
  clause = "",
  documentAttributionTerms = new Set(),
} = {}) =>
  extractFactTerms(stripNumericValueSurfaces(stripClaimLeadLabel(clause))).filter(
    (term) =>
      !documentAttributionTerms.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term) &&
      !MODALITY_CLAIM_TERMS.has(term) &&
      !NUMERIC_CONSTRAINT_SURFACE_TERMS.has(term) &&
      !DOCUMENT_ATTRIBUTION_VERBS.has(term) &&
      !DOCUMENT_IDENTITY_TERMS.has(term) &&
      !NUMERIC_DOCUMENT_WRAPPER_TERMS.has(term)
  );

const hasNumericAnchor = (value = "") => extractClaimAnchors(value).length > 0;

const splitNumericRelationClauses = (value = "") => {
  const parts = String(value ?? "").split(
    /(\s+\b(?:after|before|unless|with)\b\s+)/gi
  );
  const clauses = [];
  let current = parts[0] ?? "";

  for (let index = 1; index < parts.length; index += 2) {
    const separator = parts[index] ?? " ";
    const next = parts[index + 1] ?? "";
    const numericTemporalPrefix =
      /\b(?:after|before)\b/i.test(separator) &&
      hasNumericAnchor(current) &&
      CLAIM_PREDICATE_PATTERN.test(next);

    if (
      (hasNumericAnchor(current) && hasNumericAnchor(next)) ||
      numericTemporalPrefix
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

const splitNumericFactClauses = (value = "") =>
  splitModalityClauses(value).flatMap(splitNumericRelationClauses);

const buildNumericSupportClauseScopes = (rawSupportText = "") => {
  let inheritedBindingTerms = [];

  return splitNumericFactClauses(rawSupportText).map((clause) => {
    const localBindingTerms = getNumericClauseBindingTerms({ clause });
    const localSubjectTerms = localBindingTerms.filter(
      (term) => !NUMERIC_MEASUREMENT_TERMS.has(term)
    );
    const predicateMatch = CLAIM_PREDICATE_PATTERN.exec(
      stripClaimLeadLabel(clause)
    );
    const predicateStartsClause = predicateMatch?.index === 0;
    const explicitLeadingTerms = getClaimBindingTerms({
      claimText: clause,
    }).filter((term) => !NUMERIC_MEASUREMENT_TERMS.has(term));
    const firstNumericOccurrence = extractNumericOccurrences(clause)[0];
    const firstNumericIndex = firstNumericOccurrence?.index ?? -1;
    const postNumericSubjectTerms = firstNumericOccurrence
      ? (() => {
          const trailingText = clause
            .slice(firstNumericOccurrence.end)
            .replace(/[.!?。！？]+\s*$/g, "")
            .trim();
          const match = trailingText.match(
            /\b(?:for|to)\s+([^,;.!?。！？]+)\s*$/i
          );

          return match
            ? getNumericClauseBindingTerms({ clause: match[1] }).filter(
                (term) => !NUMERIC_MEASUREMENT_TERMS.has(term)
              )
            : [];
        })()
      : [];
    const hasPreNumericPostPredicateSubject =
      predicateStartsClause &&
      firstNumericIndex > 0 &&
      /\b(?:for|to)\s+[^,;]+$/i.test(clause.slice(0, firstNumericIndex));
    const hasPostNumericSubject =
      predicateStartsClause && postNumericSubjectTerms.length > 0;
    const inheritsPriorSubject =
      predicateStartsClause &&
      inheritedBindingTerms.length > 0 &&
      !hasPreNumericPostPredicateSubject &&
      !hasPostNumericSubject;

    if (explicitLeadingTerms.length > 0) {
      inheritedBindingTerms = explicitLeadingTerms;
    } else if (!inheritsPriorSubject && localSubjectTerms.length > 0) {
      inheritedBindingTerms = localSubjectTerms;
    }

    return {
      clause,
      modalityAnchors: getModalityLabels(clause),
      supportTerms: new Set([
        ...localBindingTerms,
        ...(inheritsPriorSubject ? inheritedBindingTerms : []),
      ]),
    };
  });
};

const isClaimAnchorSupported = ({
  anchor,
  claimText = "",
  documentAttributionTerms = new Set(),
  rawSupportText = "",
} = {}) => {
  if (anchor.type === "date") {
    return haveSameValues(
      extractDateValues(claimText),
      extractDateValues(rawSupportText)
    );
  }

  if (!["number", "numeric_constraint"].includes(anchor.type)) {
    return isAnchorSupported({ anchor, rawSupportText });
  }

  const supportClauseScopes = buildNumericSupportClauseScopes(rawSupportText);
  const bindingGroups = getNumericAnchorBindingGroups({
    anchor,
    claimText,
    documentAttributionTerms,
  });

  if (bindingGroups.length === 0) {
    return supportClauseScopes.some(({ clause }) =>
      isAnchorSupported({ anchor, rawSupportText: clause })
    );
  }

  return bindingGroups.every(({ bindingTerms, clause: claimClause, modalityAnchors }) =>
    supportClauseScopes.some((scope) => {
      const { clause, supportTerms } = scope;

      if (
        !haveSameNumericOccurrences(claimClause, clause, {
          claimIgnoredTerms: documentAttributionTerms,
          claimRoleTerms: bindingTerms,
          supportRoleTerms: [...supportTerms],
        })
      ) {
        return false;
      }

      return (
        bindingTerms.every((term) => supportTerms.has(term)) &&
        modalityAnchors.every((modality) =>
          scope.modalityAnchors.includes(modality)
        ) &&
        hasNegativePolarity(claimClause) === hasNegativePolarity(clause) &&
        areCopularRelationsSupported(claimClause, clause) &&
        !hasReversedRelationTerms(claimClause, clause)
      );
    })
  );
};

export const evaluateClaimAgainstCitations = ({
  claimText,
  citations = [],
  documentLabelCitations = citations,
  forceComparisonClaim = false,
} = {}) => {
  const documentAliases = documentLabelCitations.flatMap((citation) =>
    getCitationDocumentAliases(citation)
  );
  const factualInputClaim = normalizeDocumentReportiveClaim({
    claimText,
    documentAliases,
  });
  const anchors = extractClaimAnchors(factualInputClaim);
  const numericAnchors = anchors.filter((anchor) =>
    ["number", "numeric_constraint"].includes(anchor.type)
  );

  if (numericAnchors.length > MAX_NUMERIC_OCCURRENCES_PER_CLAIM) {
    return {
      supported: false,
      tokenOverlap: 0,
      anchors: numericAnchors
        .slice(0, MAX_NUMERIC_OCCURRENCES_PER_CLAIM)
        .map((anchor) => anchor.text),
      missingAnchors: ["numeric_scope_limit"],
    };
  }
  const modalityAnchors = getModalityLabels(factualInputClaim);
  const documentAttributionTerms = getDocumentAttributionTerms({
    claimText: factualInputClaim,
    citations: documentLabelCitations,
    forceComparisonClaim,
  });
  const supportSegments = buildCitationSupportSegments(citations, {
    includeParentSentences: false,
  });
  const compoundNumericClaim = numericAnchors.some(
    (anchor) =>
      getNumericAnchorBindingGroups({
        anchor,
        claimText: factualInputClaim,
        documentAttributionTerms,
      }).length > 1
  );
  const factualClaimText = stripClaimLeadLabel(factualInputClaim);
  const numericClaimClauses = splitModalityClauses(factualClaimText);
  const numericParentEligible =
    numericAnchors.length > 0 &&
    (numericClaimClauses.length <= 1 ||
      numericClaimClauses.every(
        (clause) => extractNumericOccurrences(clause).length > 0
      ));
  const normalizedFactualClaim = normalizeSearchText(factualClaimText);
  const parentSupportSegments = buildCitationSupportSentences(citations).filter(
    (sentence) =>
      numericParentEligible ||
      normalizeSearchText(sentence) === normalizedFactualClaim
  );
  const exactEvidenceSupportSegments = citations.flatMap((citation) =>
    CHECKABLE_CITATION_FIELDS.map((field) =>
      normalizeEvidenceText(citation?.[field])
    ).filter(
      (segment) =>
        segment &&
        normalizeExactEvidenceMatchText(segment) ===
          normalizeExactEvidenceMatchText(factualClaimText)
    )
  );
  const compoundSupportSegments =
    compoundNumericClaim && numericParentEligible
    ? citations.flatMap((citation) =>
        CHECKABLE_CITATION_FIELDS.map((field) =>
          normalizeEvidenceText(citation?.[field])
        ).filter(Boolean)
      )
    : [];
  const evaluationSegments = uniqueValues([
    ...supportSegments,
    ...parentSupportSegments,
    ...exactEvidenceSupportSegments,
    ...compoundSupportSegments,
  ]);
  const exactEvidenceSupportKeys = new Set(
    exactEvidenceSupportSegments.map((segment) =>
      normalizeExactEvidenceMatchText(segment)
    )
  );
  const claimHasNegativePolarity = hasNegativePolarity(factualInputClaim);
  const metadataFactAnchors = getMetadataFactAnchors({
    claimText: factualInputClaim,
    citations: documentLabelCitations,
  });
  const bindingTerms = getClaimBindingTerms({
    claimText: factualInputClaim,
    documentAttributionTerms,
    forceComparisonClaim,
  });
  const additiveDetailTermGroups = getAdditiveDetailTermGroups({
    claimText: factualInputClaim,
    documentAttributionTerms,
  });
  const segmentChecks = evaluationSegments.map((segment) => {
    const exactEvidenceMatch = exactEvidenceSupportKeys.has(
      normalizeExactEvidenceMatchText(segment)
    );
    const numericAnchorSupportCache = new Map();
    const orderedSupportTerms = extractFactTerms(segment);
    const supportTerms = new Set(orderedSupportTerms);
    const claimTerms = buildClaimTerms({
      claimText: factualInputClaim,
      documentLabelCitations,
      forceComparisonClaim,
      scopedCitations: citations,
      supportTerms,
    });
    const missingAnchors = anchors
      .filter(
        (anchor) => {
          const numericAnchor = ["number", "numeric_constraint"].includes(
            anchor.type
          );
          const cacheKey = numericAnchor
            ? `${anchor.type}:${anchor.normalized}`
            : null;

          if (cacheKey && numericAnchorSupportCache.has(cacheKey)) {
            return !numericAnchorSupportCache.get(cacheKey);
          }

          const supported = isClaimAnchorSupported({
            anchor,
            claimText: factualInputClaim,
            documentAttributionTerms,
            rawSupportText: segment,
          });

          if (cacheKey) {
            numericAnchorSupportCache.set(cacheKey, supported);
          }

          return !supported;
        }
      )
      .map((anchor) => anchor.text);
    const missingModalityAnchors = modalityAnchors.filter(
      (anchor) => !getModalityLabels(segment).includes(anchor)
    );
    const missingMetadataFactAnchors = metadataFactAnchors.filter(
      (anchor) => !includesNormalizedPhrase(segment, anchor)
    );
    const missingBindingTerms = bindingTerms.filter(
      (term) => !supportTerms.has(term)
    );
    const missingClaimTerms = claimTerms.filter(
      (term) => !supportTerms.has(term)
    );
    const additiveDetailsSupported = additiveDetailTermGroups.every((terms) =>
      terms.every((term) => supportTerms.has(term))
    );
    const copularRelationsSupported = areCopularRelationsSupported(
      factualInputClaim,
      segment
    );
    const relationOrderSupported =
      copularRelationsSupported &&
      !hasReversedRelationTerms(factualInputClaim, segment);
    const polaritySupported =
      hasNegativePolarity(segment) === claimHasNegativePolarity;
    const assertionSupported = !isRefutedQuotedClaim({
      claimText: factualClaimText,
      supportText: segment,
    });
    const tokenOverlap = getTokenOverlap({ claimTerms, supportTerms });

    return {
      supported:
        exactEvidenceMatch ||
        (missingAnchors.length === 0 &&
          missingModalityAnchors.length === 0 &&
          missingMetadataFactAnchors.length === 0 &&
          missingBindingTerms.length === 0 &&
          missingClaimTerms.length === 0 &&
          additiveDetailsSupported &&
          relationOrderSupported &&
          polaritySupported &&
          assertionSupported &&
          tokenOverlap >= SUPPORT_TOKEN_OVERLAP_THRESHOLD),
      tokenOverlap: exactEvidenceMatch ? 1 : tokenOverlap,
      missingAnchors: exactEvidenceMatch
        ? []
        : [
            ...missingAnchors,
            ...missingModalityAnchors,
            ...missingMetadataFactAnchors,
            ...missingBindingTerms.map((term) => `subject:${term}`),
            ...missingClaimTerms.map((term) => `term:${term}`),
            ...(additiveDetailsSupported ? [] : ["additive_detail"]),
            ...(relationOrderSupported
              ? []
              : [
                  copularRelationsSupported
                    ? "relation_order"
                    : "relation_frame",
                ]),
            ...(polaritySupported ? [] : ["polarity"]),
            ...(assertionSupported ? [] : ["refuted_mention"]),
          ],
    };
  });
  const bestCheck = segmentChecks.sort(
    (left, right) =>
      Number(right.supported) - Number(left.supported) ||
      right.tokenOverlap - left.tokenOverlap ||
      left.missingAnchors.length - right.missingAnchors.length
  )[0] ?? {
    supported: false,
    tokenOverlap: 0,
    missingAnchors: [],
  };

  return {
    supported: bestCheck.supported,
    tokenOverlap: bestCheck.tokenOverlap,
    anchors: [
      ...anchors.map((anchor) => anchor.text),
      ...modalityAnchors,
      ...metadataFactAnchors,
    ],
    missingAnchors: bestCheck.missingAnchors,
  };
};

export const evaluateDocumentGroupSupport = ({
  claimText,
  group,
  documentLabelCitations,
  scopedCitations,
  sourceRanks,
} = {}) => {
  const check = evaluateClaimAgainstCitations({
    claimText,
    citations: group.citations,
    documentLabelCitations,
    forceComparisonClaim: true,
  });

  if (!check.supported) {
    return {
      check,
      supportedSourceRanks: [],
    };
  }

  const individuallySupportingCitations = group.citations.filter((citation) =>
    evaluateClaimAgainstCitations({
      claimText,
      citations: [citation],
      documentLabelCitations,
      forceComparisonClaim: true,
    }).supported
  );

  if (individuallySupportingCitations.length > 0) {
    return {
      check,
      supportedSourceRanks: uniqueValues(
        individuallySupportingCitations.map((citation) =>
          getCitationSourceRank({ citation, scopedCitations, sourceRanks })
        )
      ),
    };
  }

  let contributingCitations = [...group.citations];

  for (const citation of group.citations) {
    const reducedCitations = contributingCitations.filter(
      (candidate) => candidate !== citation
    );

    if (
      reducedCitations.length > 0 &&
      evaluateClaimAgainstCitations({
        claimText,
        citations: reducedCitations,
        documentLabelCitations,
        forceComparisonClaim: true,
      }).supported
    ) {
      contributingCitations = reducedCitations;
    }
  }

  return {
    check,
    supportedSourceRanks: uniqueValues(
      contributingCitations.map((citation) =>
        getCitationSourceRank({ citation, scopedCitations, sourceRanks })
      )
    ),
  };
};

const buildUnsupportedRelationCheck = (claimText = "") => ({
  supported: false,
  tokenOverlap: 0,
  anchors: extractClaimAnchors(claimText).map((anchor) => anchor.text),
  missingAnchors: [],
  supportedSourceRanks: [],
});

const CONTRAST_CONTEXT_TERM_ALIASES = new Map([
  ["approval", "approval"],
  ["approvals", "approval"],
  ["approver", "approval"],
  ["approvers", "approval"],
  ["authorisation", "approval"],
  ["authorisations", "approval"],
  ["authorization", "approval"],
  ["authorizations", "approval"],
  ["authorities", "approval"],
  ["authority", "approval"],
  ["off", "approval"],
  ["permission", "approval"],
  ["permissions", "approval"],
  ["sign", "approval"],
  ["signoff", "approval"],
  ["use", "use"],
  ["used", "use"],
  ["uses", "use"],
  ["using", "use"],
]);

const CONTROLLED_NUMBER_VALUE_ALIASES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
].map((word, value) => ({
  canonical: `number_${value}`,
  aliases: [word],
}));

const CONTROLLED_CONTRAST_VALUE_ALIASES = [
  { canonical: "manager", aliases: ["manager", "managers"] },
  { canonical: "director", aliases: ["director", "directors"] },
  { canonical: "human_resources", aliases: ["hr", "human resources"] },
  {
    canonical: "chief_executive_officer",
    aliases: ["ceo", "chief executive officer"],
  },
  {
    canonical: "united_states",
    aliases: ["u s", "united states"],
  },
  ...CONTROLLED_NUMBER_VALUE_ALIASES,
];

const CONTROLLED_CONTRAST_VALUE_TERMS = new Set(
  CONTROLLED_CONTRAST_VALUE_ALIASES.flatMap(({ aliases }) =>
    aliases.flatMap(extractFactTerms)
  )
);

const NUMERIC_MEASUREMENT_FAMILY_ALIASES = new Map([
  ["amount", "money"],
  ["amounts", "money"],
  ["budget", "money"],
  ["budgets", "money"],
  ["cost", "money"],
  ["costs", "money"],
  ["dollar", "money"],
  ["dollars", "money"],
  ["day", "time"],
  ["days", "time"],
  ["duration", "time"],
  ["durations", "time"],
  ["hour", "time"],
  ["hours", "time"],
  ["minute", "time"],
  ["minutes", "time"],
  ["month", "time"],
  ["months", "time"],
  ["week", "time"],
  ["weeks", "time"],
  ["year", "time"],
  ["years", "time"],
  ["percentage", "rate"],
  ["percentages", "rate"],
  ["rate", "rate"],
  ["rates", "rate"],
  ["time", "time"],
  ["times", "time"],
]);

const QUANTITY_UNIT_SCALES = new Map([
  ["millisecond", { dimension: "fixed_time_ms", factor: 1 }],
  ["minute", { dimension: "fixed_time_ms", factor: 60_000 }],
  ["hour", { dimension: "fixed_time_ms", factor: 3_600_000 }],
  ["day", { dimension: "fixed_time_ms", factor: 86_400_000 }],
  ["week", { dimension: "fixed_time_ms", factor: 604_800_000 }],
  ["month", { dimension: "calendar_month", factor: 1 }],
  ["year", { dimension: "calendar_month", factor: 12 }],
]);

const normalizeScaledQuantity = (value, factor) => {
  const numericValue = Number(String(value ?? "").replace(/%$/, ""));

  return Number.isFinite(numericValue)
    ? String(Number((numericValue * factor).toPrecision(12)))
    : "";
};

const canonicalizeNumericFactQuantity = (fact = {}) => {
  if (fact.metadata || fact.measurementTerms?.length !== 1) {
    return "";
  }

  const measurement = fact.measurementTerms[0];
  const scaledUnit = QUANTITY_UNIT_SCALES.get(measurement);
  const dimension = scaledUnit?.dimension ?? `unit:${measurement}`;
  const factor = scaledUnit?.factor ?? 1;
  const values = (fact.values ?? []).map((value) =>
    normalizeScaledQuantity(value, factor)
  );

  return values.length > 0 && values.every(Boolean)
    ? `${fact.operator}:${dimension}:${values.join(":")}`
    : "";
};

const getControlledContrastValues = (value = "") =>
  CONTROLLED_CONTRAST_VALUE_ALIASES.flatMap(({ canonical, aliases }) =>
    aliases.some((alias) => includesNormalizedPhrase(value, alias))
      ? [canonical]
      : []
  );

const intersectTermSets = (termSets = []) => {
  if (termSets.length === 0) {
    return new Set();
  }

  return new Set(
    [...termSets[0]].filter((term) =>
      termSets.slice(1).every((terms) => terms.has(term))
    )
  );
};

const serializeValues = (values = []) => [...new Set(values)].sort().join("|");

const COPULAR_VALUE_SLOT_PATTERN = /\b(?:is|are|was|were)\b/i;

const buildPredicateValueSlot = ({
  attributionTerms = new Set(),
  clause = "",
  supportTerms = new Set(),
} = {}) => {
  if (extractNumericOccurrences(clause).length > 0) {
    return null;
  }

  const normalizedClause = normalizeSemanticText(clause);
  const predicate = COPULAR_VALUE_SLOT_PATTERN.exec(normalizedClause);

  if (!predicate) {
    return null;
  }

  const keepGroundedSlotTerm = (term) =>
    supportTerms.has(term) &&
    !attributionTerms.has(term) &&
    !COMPARISON_SCAFFOLD_TERMS.has(term) &&
    !DOCUMENT_IDENTITY_TERMS.has(term) &&
    !DOCUMENT_ATTRIBUTION_VERBS.has(term) &&
    !MODALITY_CLAIM_TERMS.has(term);
  const topic = extractFactTerms(
    normalizedClause.slice(0, predicate.index)
  ).filter(keepGroundedSlotTerm);
  const value = extractFactTerms(
    normalizedClause.slice(predicate.index + predicate[0].length)
  ).filter(keepGroundedSlotTerm);

  return topic.length > 0 && value.length > 0
    ? {
        predicate: "copular",
        topic: serializeValues(topic),
        value: serializeValues(value),
      }
    : null;
};

const buildContrastFactSignature = ({
  clause = "",
  citations = [],
} = {}) => {
  const comparisonClause = String(clause ?? "").replace(
    /^.*?\bdiffer(?:s|ed|ent)?\b\s*:?\s*/i,
    ""
  );
  const factualClause = normalizeDocumentReportiveClaim({
    claimText: comparisonClause,
    documentAliases: citations.flatMap((citation) =>
      getCitationDocumentAliases(citation)
    ),
  });
  const attributionTerms = getDocumentAttributionTerms({
    claimText: factualClause,
    citations,
    forceComparisonClaim: true,
  });
  const supportTerms = new Set(
    buildCitationSupportSegments(citations).flatMap(extractFactTerms)
  );
  const groundedTerms = extractFactTerms(
    stripNumericValueSurfaces(factualClause)
  ).filter((term) => supportTerms.has(term));
  const context = [];
  const relationShape = [];
  const values = [];

  for (const term of groundedTerms) {
    if (
      attributionTerms.has(term) ||
      COMPARISON_SCAFFOLD_TERMS.has(term) ||
      CONTRAST_STYLE_TERMS.has(term) ||
      DOCUMENT_IDENTITY_TERMS.has(term)
    ) {
      continue;
    }

    const contextAlias = CONTRAST_CONTEXT_TERM_ALIASES.get(term);
    const measurementFamily = NUMERIC_MEASUREMENT_FAMILY_ALIASES.get(term);

    if (CONTROLLED_CONTRAST_VALUE_TERMS.has(term)) {
      relationShape.push("controlled_value");
    } else if (measurementFamily) {
      relationShape.push(`measurement:${measurementFamily}`);
    } else if (contextAlias) {
      relationShape.push(`context:${contextAlias}`);
    } else if (
      !MODALITY_CLAIM_TERMS.has(term) &&
      !DOCUMENT_ATTRIBUTION_VERBS.has(term)
    ) {
      relationShape.push(`term:${term}`);
    }

    if (
      contextAlias ||
      MODALITY_CLAIM_TERMS.has(term) ||
      DOCUMENT_ATTRIBUTION_VERBS.has(term)
    ) {
      context.push(contextAlias ?? term);
      continue;
    }

    values.push(term);
  }

  const extractedAnchors = extractClaimAnchors(factualClause);
  const numericConstraints = extractedAnchors.filter(
    (anchor) => anchor.type === "numeric_constraint"
  );
  const anchors = (numericConstraints.length > 0
    ? [
        ...numericConstraints,
        ...extractedAnchors.filter(
          (anchor) => !["numeric_constraint", "number"].includes(anchor.type)
        ),
      ]
    : extractedAnchors
  ).map((anchor) =>
    anchor.type === "number"
      ? `${anchor.type}:${normalizeNumericAnchor(anchor.text)}`
      : `${anchor.type}:${anchor.normalized}`
  );
  const modality = getModalityLabels(factualClause);
  const numericFacts = buildNumericOccurrenceFacts(factualClause, {
    ignoredTerms: attributionTerms,
  }).facts;
  const predicateMatch = CLAIM_PREDICATE_PATTERN.exec(factualClause);
  const predicatePrefix = predicateMatch
    ? factualClause.slice(0, predicateMatch.index)
    : "";
  const scopeTerms = predicateMatch
    ? extractFactTerms(predicatePrefix).filter(
        (term) =>
          supportTerms.has(term) &&
          !attributionTerms.has(term) &&
          !COMPARISON_SCAFFOLD_TERMS.has(term) &&
          !DOCUMENT_IDENTITY_TERMS.has(term) &&
          !DOCUMENT_ATTRIBUTION_VERBS.has(term) &&
          !MODALITY_CLAIM_TERMS.has(term)
      )
    : [];

  return {
    anchors: uniqueValues(anchors),
    controlledValues: uniqueValues(
      getControlledContrastValues(factualClause)
    ),
    context: uniqueValues([
      ...context,
      ...modality.map((label) => `modality:${label}`),
    ]),
    modality: uniqueValues(modality),
    predicateValueSlot: buildPredicateValueSlot({
      attributionTerms,
      clause: factualClause,
      supportTerms,
    }),
    quantitySignatures: uniqueValues(
      numericFacts.map(canonicalizeNumericFactQuantity)
    ),
    relationShape,
    hasExplicitScopeRestriction:
      EXCLUSIVE_RELATION_PATTERN.test(predicatePrefix),
    scopeTerms: uniqueValues(scopeTerms),
    values: uniqueValues(values),
  };
};

const hasPredicateValueContrast = (factSignatures = []) => {
  const slots = factSignatures.map(
    (signature) => signature.predicateValueSlot
  );

  return (
    slots.every(Boolean) &&
    new Set(slots.map((slot) => `${slot.predicate}:${slot.topic}`)).size === 1 &&
    slots.every((slot) => Boolean(slot.value)) &&
    new Set(slots.map((slot) => slot.value)).size > 1
  );
};

const hasSubstantiveContrast = (factSignatures = []) => {
  if (factSignatures.length < 2) {
    return false;
  }

  if (hasPredicateValueContrast(factSignatures)) {
    return true;
  }

  const scopeSets = factSignatures.map(
    (signature) => new Set(signature.scopeTerms ?? [])
  );
  const hasStrictScopeSubset = scopeSets.some((candidate, candidateIndex) =>
    scopeSets.some(
      (other, otherIndex) =>
        candidateIndex !== otherIndex &&
        candidate.size > 0 &&
        candidate.size < other.size &&
        [...candidate].every((term) => other.has(term))
    )
  );
  const sharedNonScopeFacts = intersectTermSets(
    factSignatures.map(
      (signature, index) =>
        new Set(
          signature.values.filter((term) => !scopeSets[index].has(term))
        )
    )
  );
  const scopeQuantityValues = factSignatures.map((signature) =>
    serializeValues(signature.anchors)
  );
  const scopeModalityValues = factSignatures.map((signature) =>
    serializeValues(signature.modality)
  );

  if (
    hasStrictScopeSubset &&
    factSignatures.some(
      (signature) => signature.hasExplicitScopeRestriction === true
    ) &&
    sharedNonScopeFacts.size >= 2 &&
    scopeQuantityValues.every(Boolean) &&
    new Set(scopeQuantityValues).size === 1 &&
    new Set(scopeModalityValues).size === 1
  ) {
    return true;
  }

  const contextSets = factSignatures.map(
    (signature) => new Set(signature.context)
  );
  const subjectSets = factSignatures.map(
    (signature) =>
      new Set(
        signature.values.filter(
          (term) =>
            !NUMERIC_MEASUREMENT_TERMS.has(term) &&
            !CONTROLLED_CONTRAST_VALUE_TERMS.has(term)
        )
      )
  );
  const measurementSets = factSignatures.map(
    (signature) =>
      new Set(
        signature.values.flatMap((term) => {
          const family = NUMERIC_MEASUREMENT_FAMILY_ALIASES.get(term);
          return family ? [family] : [];
        })
      )
  );
  const sharedContext = intersectTermSets(contextSets);
  const sharedSubjects = intersectTermSets(subjectSets);
  const sharedMeasurements = intersectTermSets(measurementSets);
  const sharedNonModalityContext = new Set(
    [...sharedContext].filter((term) => !term.startsWith("modality:"))
  );
  const allSubjectsImplicit = subjectSets.every((terms) => terms.size === 0);
  const allMeasurementsImplicit = measurementSets.every(
    (terms) => terms.size === 0
  );
  const measurementsComparable =
    allMeasurementsImplicit ||
    (measurementSets.every((terms) => terms.size > 0) &&
      sharedMeasurements.size > 0);
  const relationShapes = factSignatures.map((signature) =>
    signature.relationShape.join("|")
  );
  const relationShapesComparable =
    relationShapes.every((shape) => !shape) ||
    new Set(relationShapes).size === 1;
  const smallestSubjectSize = Math.min(
    ...subjectSets.map((terms) => terms.size)
  );
  const largestSubjectSize = Math.max(
    ...subjectSets.map((terms) => terms.size)
  );
  const subjectsMatch =
    !allSubjectsImplicit &&
    sharedSubjects.size === smallestSubjectSize &&
    largestSubjectSize === smallestSubjectSize;
  const comparable =
    measurementsComparable &&
    relationShapesComparable &&
    (subjectsMatch ||
      (allSubjectsImplicit &&
        (sharedMeasurements.size > 0 || sharedNonModalityContext.size > 0)));

  if (!comparable) {
    return false;
  }

  const anchorValues = factSignatures.map((signature) =>
    serializeValues(signature.anchors)
  );
  const quantities = factSignatures.map((signature) =>
    serializeValues(signature.quantitySignatures)
  );
  const allQuantitiesBound = quantities.every(Boolean);

  if (allQuantitiesBound && new Set(quantities).size > 1) {
    return true;
  }

  if (
    anchorValues.every(Boolean) &&
    new Set(anchorValues).size > 1 &&
    !allQuantitiesBound
  ) {
    return true;
  }

  const modalityValues = factSignatures.map((signature) =>
    serializeValues(signature.modality)
  );

  if (
    modalityValues.every(Boolean) &&
    new Set(modalityValues).size > 1
  ) {
    return true;
  }

  const controlledValueSignatures = factSignatures.map((signature) =>
    serializeValues(signature.controlledValues)
  );

  return (
    controlledValueSignatures.every(Boolean) &&
    new Set(controlledValueSignatures).size > 1
  );
};

const buildDifferenceClaimEntry = ({
  claim,
  citations = [],
} = {}) => {
  const sourceRanks = new Set(claim?.sourceRanks ?? []);
  const scopedCitationEntries = citations
    .map((citation, index) => {
      const explicitRank = Number(citation?.rank);
      const rank =
        Number.isInteger(explicitRank) && explicitRank > 0
          ? explicitRank
          : index + 1;

      return { citation, index, rank };
    })
    .filter((entry) => sourceRanks.has(entry.rank));
  const scopedCitations = scopedCitationEntries.map((entry) => entry.citation);
  const attributedIdentities = getExplicitlyAttributedCitationIdentities({
    claimText: claim?.text,
    citations,
  });
  const scopedIdentities = new Set(
    scopedCitationEntries.map(({ citation, index }) =>
      getCitationIdentity(citation, index)
    )
  );

  if (
    attributedIdentities.length !== 1 ||
    scopedIdentities.size !== 1 ||
    !scopedIdentities.has(attributedIdentities[0])
  ) {
    return null;
  }

  return {
    documentIdentity: attributedIdentities[0],
    factSignature: buildContrastFactSignature({
      clause: claim.text,
      citations: scopedCitations,
    }),
  };
};

const canPairDifferenceEntries = (left, right) =>
  left.documentIdentity !== right.documentIdentity &&
  hasSubstantiveContrast([left.factSignature, right.factSignature]);

const canMatchDifferencePartitions = (leftEntries, rightEntries) => {
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  const rightToLeft = new Array(rightEntries.length).fill(-1);
  const assignLeft = (leftIndex, visitedRightIndexes) => {
    for (let rightIndex = 0; rightIndex < rightEntries.length; rightIndex += 1) {
      if (
        visitedRightIndexes.has(rightIndex) ||
        !canPairDifferenceEntries(
          leftEntries[leftIndex],
          rightEntries[rightIndex]
        )
      ) {
        continue;
      }

      visitedRightIndexes.add(rightIndex);
      const priorLeftIndex = rightToLeft[rightIndex];

      if (
        priorLeftIndex === -1 ||
        assignLeft(priorLeftIndex, visitedRightIndexes)
      ) {
        rightToLeft[rightIndex] = leftIndex;
        return true;
      }
    }

    return false;
  };

  return leftEntries.every((_entry, leftIndex) =>
    assignLeft(leftIndex, new Set())
  );
};

const MAX_MULTIPARTITE_DIFFERENCE_ENTRIES = 18;

const canPairMultipartiteDifferenceEntries = (entries = []) => {
  if (entries.length > MAX_MULTIPARTITE_DIFFERENCE_ENTRIES) {
    return false;
  }

  const fullMask = (1n << BigInt(entries.length)) - 1n;
  const memo = new Map();
  const findPairing = (mask) => {
    if (mask === 0n) {
      return true;
    }

    const memoKey = mask.toString();

    if (memo.has(memoKey)) {
      return memo.get(memoKey);
    }

    let firstIndex = 0;

    while ((mask & (1n << BigInt(firstIndex))) === 0n) {
      firstIndex += 1;
    }

    const withoutFirst = mask & ~(1n << BigInt(firstIndex));

    for (let candidateIndex = firstIndex + 1; candidateIndex < entries.length; candidateIndex += 1) {
      const candidateBit = 1n << BigInt(candidateIndex);

      if (
        (withoutFirst & candidateBit) === 0n ||
        !canPairDifferenceEntries(
          entries[firstIndex],
          entries[candidateIndex]
        )
      ) {
        continue;
      }

      if (findPairing(withoutFirst & ~candidateBit)) {
        memo.set(memoKey, true);
        return true;
      }
    }

    memo.set(memoKey, false);
    return false;
  };

  return findPairing(fullMask);
};

const canPairAllDifferenceEntries = (entries = []) => {
  if (entries.length === 0) {
    return true;
  }

  const documentIdentities = uniqueValues(
    entries.map((entry) => entry.documentIdentity)
  );

  if (documentIdentities.length === 2) {
    const [leftIdentity, rightIdentity] = documentIdentities;

    return canMatchDifferencePartitions(
      entries.filter((entry) => entry.documentIdentity === leftIdentity),
      entries.filter((entry) => entry.documentIdentity === rightIdentity)
    );
  }

  return canPairMultipartiteDifferenceEntries(entries);
};

const isStandaloneDifferenceClaimSupported = ({
  claim,
  citations = [],
} = {}) => {
  const sourceRanks = claim?.sourceRanks ?? [];
  const scopedCitations = filterCitationsToSourceRanks({
    citations,
    sourceRanks,
  });

  return (
    evaluateContrastClaimSupport({
      claimText: claim?.text,
      scopedCitations,
      sourceRanks,
    })?.supported === true
  );
};

export const evaluateDifferenceSectionSupport = ({
  claims = [],
  citations = [],
} = {}) => {
  if (claims.length === 0) {
    return false;
  }

  const standaloneClaims = new Set(
    claims.filter((claim) =>
      isStandaloneDifferenceClaimSupported({ claim, citations })
    )
  );

  if (claims.length === 1) {
    return standaloneClaims.size === 1;
  }

  const atomicClaims = claims.filter((claim) => !standaloneClaims.has(claim));

  if (atomicClaims.length % 2 !== 0) {
    return false;
  }

  const entries = atomicClaims.map((claim) =>
    buildDifferenceClaimEntry({ claim, citations })
  );

  return entries.every(Boolean) && canPairAllDifferenceEntries(entries);
};

export const evaluateContrastClaimSupport = ({
  claimText,
  scopedCitations,
  sourceRanks = [],
} = {}) => {
  if (!CONTRAST_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const documentGroups = groupCitationsByDocument(scopedCitations);

  if (documentGroups.length < 2) {
    return null;
  }

  const mentionsComparedDocument = documentGroups.some((group) =>
    getGroupDocumentAliases(group).some((alias) =>
      includesNormalizedPhrase(claimText, alias)
    )
  );

  if (!mentionsComparedDocument) {
    return buildUnsupportedRelationCheck(claimText);
  }

  if (documentGroups.length < 2 || sourceRanks.length === 0) {
    return buildUnsupportedRelationCheck(claimText);
  }

  const clauses = String(claimText ?? "")
    .split(
      /\s*(?:,|，)?\s*(?:\b(?:but|however|while|whilst|whereas|yet|versus|vs)\b|而|但是?|然而|相比之下|相较之下)\s*/i
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
  const clauseChecks = [];
  const factSignatures = [];
  const supportingSourceRanks = [];
  const boundDocumentIdentities = new Set();

  for (const clause of clauses) {
    const matchingGroups = documentGroups.filter((group) =>
      getGroupDocumentAliases(group).some((alias) =>
        includesNormalizedPhrase(clause, alias)
      )
    );

    for (const group of matchingGroups) {
      boundDocumentIdentities.add(group.identity);
      factSignatures.push(
        buildContrastFactSignature({
          clause,
          citations: group.citations,
        })
      );
      const groupSupport = evaluateDocumentGroupSupport({
        claimText: clause,
        group,
        documentLabelCitations: scopedCitations,
        scopedCitations,
        sourceRanks,
      });
      clauseChecks.push(groupSupport.check);
      supportingSourceRanks.push(...groupSupport.supportedSourceRanks);
    }
  }

  if (
    clauseChecks.length < 2 ||
    boundDocumentIdentities.size !== documentGroups.length
  ) {
    return buildUnsupportedRelationCheck(claimText);
  }

  return {
    supported:
      clauseChecks.every((check) => check.supported) &&
      hasSubstantiveContrast(factSignatures),
    tokenOverlap: Math.min(...clauseChecks.map((check) => check.tokenOverlap)),
    anchors: uniqueValues(clauseChecks.flatMap((check) => check.anchors)),
    missingAnchors: uniqueValues(
      clauseChecks.flatMap((check) => check.missingAnchors)
    ),
    supportedSourceRanks: uniqueValues(supportingSourceRanks),
  };
};

export const evaluateAgreementClaimSupport = ({
  claimText,
  scopedCitations,
  sourceRanks = [],
} = {}) => {
  if (
    !AGREEMENT_RELATION_PATTERN.test(claimText) &&
    !BARE_BOTH_AGREEMENT_PATTERN.test(claimText)
  ) {
    return null;
  }

  const documentGroups = groupCitationsByDocument(scopedCitations);
  const claimedCardinality = getDocumentRelationCardinality(claimText);

  if (
    documentGroups.length < 2 ||
    sourceRanks.length === 0 ||
    (claimedCardinality !== null && claimedCardinality !== documentGroups.length)
  ) {
    return buildUnsupportedRelationCheck(claimText);
  }

  const documentSupport = documentGroups.map((group) =>
    evaluateDocumentGroupSupport({
      claimText,
      group,
      documentLabelCitations: scopedCitations,
      scopedCitations,
      sourceRanks,
    })
  );
  const documentChecks = documentSupport.map((result) => result.check);

  return {
    supported: documentChecks.every((check) => check.supported),
    tokenOverlap: Math.min(...documentChecks.map((check) => check.tokenOverlap)),
    anchors: uniqueValues(documentChecks.flatMap((check) => check.anchors)),
    missingAnchors: uniqueValues(
      documentChecks.flatMap((check) => check.missingAnchors)
    ),
    supportedSourceRanks: uniqueValues(
      documentSupport.flatMap((result) => result.supportedSourceRanks)
    ),
  };
};

export const evaluateExclusiveClaimSupport = ({
  allCitations,
  claimText,
  sourceRanks = [],
} = {}) => {
  if (!EXCLUSIVE_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const allDocumentGroups = groupCitationsByDocument(allCitations);

  if (allDocumentGroups.length < 2) {
    return null;
  }

  const exclusiveClause = String(claimText ?? "")
    .split(/\s*,?\s*\b(?:while|whereas)\b\s*/i)[0]
    .trim();
  const documentAliases = allDocumentGroups.flatMap((group) =>
    getGroupDocumentAliases(group)
  );
  const factualExclusiveClause = normalizeDocumentReportiveClaim({
    claimText: exclusiveClause,
    documentAliases,
  });
  const normalizedClauseTerms = normalizeSearchText(
    factualExclusiveClause
  ).split(/\s+/g);
  const exclusiveTokenIndexes = normalizedClauseTerms
    .map((term, index) =>
      ["only", "solely", "exclusively", "alone"].includes(term)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  const exclusiveDirectlyTargetsAlias = allDocumentGroups.some((group) =>
    getGroupDocumentAliases(group).some((alias) => {
      const normalizedAlias = normalizeSearchText(alias);
      const aliasTerms = normalizedAlias.split(/\s+/g);
      const aliasPattern = aliasTerms
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^a-z0-9一-鿿]+");

      if (
        new RegExp(
          `(?:^|\\s|[-*])${aliasPattern}\\s*[:：]`,
          "i"
        ).test(factualExclusiveClause)
      ) {
        return false;
      }
      const aliasIndex = normalizedClauseTerms.findIndex((term, index) =>
        aliasTerms.every(
          (aliasTerm, offset) => normalizedClauseTerms[index + offset] === aliasTerm
        )
      );

      if (aliasIndex < 0) {
        return false;
      }

      const aliasEndIndex = aliasIndex + aliasTerms.length - 1;

      return exclusiveTokenIndexes.some(
        (exclusiveIndex) =>
          (exclusiveIndex < aliasIndex && aliasIndex - exclusiveIndex <= 3) ||
          (exclusiveIndex > aliasEndIndex && exclusiveIndex - aliasEndIndex <= 2)
      );
    })
  );
  const genericDocumentExclusive = GENERIC_EXCLUSIVE_DOCUMENT_PATTERN.test(
    factualExclusiveClause
  );
  const sourceScopedExclusive =
    sourceRanks.length > 0 &&
    SOURCE_SCOPED_EXCLUSIVE_PATTERN.test(factualExclusiveClause);

  if (
    !exclusiveDirectlyTargetsAlias &&
    !genericDocumentExclusive &&
    !sourceScopedExclusive
  ) {
    return null;
  }

  return buildUnsupportedRelationCheck(claimText);
};

export const evaluateNoDifferenceClaimSupport = ({
  claimText,
  comparisonAnalysisSummary,
  scopedCitations,
  sourceRanks = [],
} = {}) => {
  if (!NO_DIFFERENCE_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const explicitConflictPairs = Array.isArray(
    comparisonAnalysisSummary?.explicitConflictPairs
  )
    ? comparisonAnalysisSummary.explicitConflictPairs
    : [];
  const comparedDocIds = Array.isArray(
    comparisonAnalysisSummary?.comparedDocIds
  )
    ? comparisonAnalysisSummary.comparedDocIds
        .map((docId) => normalizeEvidenceText(docId))
        .filter(Boolean)
    : [];
  const scopedDocumentGroups = groupCitationsByDocument(scopedCitations);
  const scopedDocIds = scopedDocumentGroups
    .map((group) => group.docId)
    .filter(Boolean);
  const supported =
    EVIDENCE_SCOPED_NO_DIFFERENCE_PATTERN.test(claimText) &&
    sourceRanks.length >= 2 &&
    scopedDocumentGroups.length >= 2 &&
    scopedDocIds.length === scopedDocumentGroups.length &&
    haveSameValues(comparedDocIds, scopedDocIds) &&
    comparisonAnalysisSummary?.shouldShortCircuitNoMaterialDifference === true &&
    explicitConflictPairs.length === 0;

  return {
    supported,
    tokenOverlap: supported ? 1 : 0,
    anchors: extractClaimAnchors(claimText).map((anchor) => anchor.text),
    missingAnchors: [],
    supportedSourceRanks: supported
      ? uniqueValues(
          scopedDocumentGroups.map((group) =>
            getCitationSourceRank({
              citation: group.citations[0],
              scopedCitations,
              sourceRanks,
            })
          )
        )
      : [],
  };
};

export const combineRelationSupportChecks = (checks = []) => {
  const activeChecks = checks.filter(Boolean);

  if (activeChecks.length === 0) {
    return null;
  }

  return {
    supported: activeChecks.every((check) => check.supported),
    tokenOverlap: Math.min(...activeChecks.map((check) => check.tokenOverlap)),
    anchors: uniqueValues(activeChecks.flatMap((check) => check.anchors)),
    missingAnchors: uniqueValues(
      activeChecks.flatMap((check) => check.missingAnchors)
    ),
    supportedSourceRanks: uniqueValues(
      activeChecks.flatMap((check) => check.supportedSourceRanks ?? [])
    ),
  };
};
