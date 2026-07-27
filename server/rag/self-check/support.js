import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import {
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
  NO_DIFFERENCE_RELATION_PATTERN,
  EVIDENCE_SCOPED_NO_DIFFERENCE_PATTERN,
  SOURCE_SCOPED_EXCLUSIVE_PATTERN,
  SUPPORT_TOKEN_OVERLAP_THRESHOLD,
} from "./patterns.js";
import {
  extractFactTerms,
  getChineseModalitySurfaceTerms,
  getTokenOverlap,
  hasNegativePolarity,
  haveSameValues,
  includesNormalizedPhrase,
  isAnchorSupported,
  normalizeEvidenceText,
  normalizeNumericAnchor,
  normalizeNumericConstraint,
  stripClaimLeadLabel,
  uniqueValues,
} from "./text.js";
import { getModalityLabels } from "./modality.js";
import {
  buildCitationSupportSegments,
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

  return extractFactTerms(factualClaimText).filter((term) => {
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

    return !(
      comparisonClaim &&
      !supportTerms.has(term) &&
      COMPARISON_SCAFFOLD_TERMS.has(term)
    );
  });
};

export const evaluateClaimAgainstCitations = ({
  claimText,
  citations = [],
  documentLabelCitations = citations,
  forceComparisonClaim = false,
} = {}) => {
  const anchors = extractClaimAnchors(claimText);
  const modalityAnchors = getModalityLabels(claimText);
  const documentAttributionTerms = getDocumentAttributionTerms({
    claimText,
    citations: documentLabelCitations,
    forceComparisonClaim,
  });
  const supportSegments = buildCitationSupportSegments(citations);
  const claimHasNegativePolarity = hasNegativePolarity(claimText);
  const metadataFactAnchors = getMetadataFactAnchors({
    claimText,
    citations: documentLabelCitations,
  });
  const bindingTerms = getClaimBindingTerms({
    claimText,
    documentAttributionTerms,
    forceComparisonClaim,
  });
  const additiveDetailTermGroups = getAdditiveDetailTermGroups({
    claimText,
    documentAttributionTerms,
  });
  const segmentChecks = supportSegments.map((segment) => {
    const supportTerms = new Set(extractFactTerms(segment));
    const claimTerms = buildClaimTerms({
      claimText,
      documentLabelCitations,
      forceComparisonClaim,
      scopedCitations: citations,
      supportTerms,
    });
    const missingAnchors = anchors
      .filter((anchor) => !isAnchorSupported({ anchor, rawSupportText: segment }))
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
    const polaritySupported =
      hasNegativePolarity(segment) === claimHasNegativePolarity;
    const tokenOverlap = getTokenOverlap({ claimTerms, supportTerms });

    return {
      supported:
        missingAnchors.length === 0 &&
        missingModalityAnchors.length === 0 &&
        missingMetadataFactAnchors.length === 0 &&
        missingBindingTerms.length === 0 &&
        missingClaimTerms.length === 0 &&
        additiveDetailsSupported &&
        polaritySupported &&
        tokenOverlap >= SUPPORT_TOKEN_OVERLAP_THRESHOLD,
      tokenOverlap,
      missingAnchors: [
        ...missingAnchors,
        ...missingModalityAnchors,
        ...missingMetadataFactAnchors,
        ...missingBindingTerms.map((term) => `subject:${term}`),
        ...missingClaimTerms.map((term) => `term:${term}`),
        ...(additiveDetailsSupported ? [] : ["additive_detail"]),
        ...(polaritySupported ? [] : ["polarity"]),
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

const buildContrastFactSignature = ({
  clause = "",
  citations = [],
} = {}) => {
  const factualClause = String(clause ?? "").replace(
    /^.*?\bdiffer(?:s|ed|ent)?\b\s*:?\s*/i,
    ""
  );
  const attributionTerms = getDocumentAttributionTerms({
    claimText: factualClause,
    citations,
    forceComparisonClaim: true,
  });
  const terms = extractMeaningfulTokens(factualClause).filter(
    (term) =>
      !attributionTerms.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term) &&
      !CONTRAST_STYLE_TERMS.has(term) &&
      !MODALITY_CLAIM_TERMS.has(term) &&
      !DOCUMENT_ATTRIBUTION_VERBS.has(term) &&
      !DOCUMENT_IDENTITY_TERMS.has(term)
  );
  const anchors = extractClaimAnchors(factualClause).map((anchor) =>
    anchor.type === "number"
      ? `${anchor.type}:${normalizeNumericAnchor(anchor.text)}`
      : `${anchor.type}:${anchor.normalized}`
  );

  return {
    fact: uniqueValues([...terms, ...anchors]).sort().join("|"),
    modality: getModalityLabels(factualClause).sort().join("|"),
  };
};

const hasSubstantiveContrast = (factSignatures = []) => {
  const factValues = factSignatures.map((signature) => signature.fact);

  if (new Set(factValues.filter(Boolean)).size > 1) {
    return true;
  }

  const modalityValues = factSignatures.map((signature) => signature.modality);

  return (
    modalityValues.every(Boolean) && new Set(modalityValues).size > 1
  );
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
      tokenOverlap: Math.min(
        ...documentChecks.map((check) => check.tokenOverlap)
      ),
      anchors: uniqueValues(
        documentChecks.flatMap((check) => check.anchors)
      ),
      missingAnchors: uniqueValues(
        documentChecks.flatMap((check) => check.missingAnchors)
      ),
      supportedSourceRanks: uniqueValues(
        documentSupport.flatMap((result) => result.supportedSourceRanks)
      ),
    };
  }

  if (documentGroups.length < 2 || sourceRanks.length === 0) {
    return buildUnsupportedRelationCheck(claimText);
  }

  const clauses = String(claimText ?? "")
    .split(
      /\s*(?:,|，)?\s*(?:\b(?:while|whereas|versus|vs)\b|而|但是?|然而|相比之下|相较之下)\s*/i
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
          citations: scopedCitations,
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
  if (!AGREEMENT_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const documentGroups = groupCitationsByDocument(scopedCitations);

  if (documentGroups.length < 2 || sourceRanks.length === 0) {
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
  const normalizedClauseTerms = normalizeSearchText(exclusiveClause).split(/\s+/g);
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
    exclusiveClause
  );
  const sourceScopedExclusive =
    sourceRanks.length > 0 && SOURCE_SCOPED_EXCLUSIVE_PATTERN.test(exclusiveClause);

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
