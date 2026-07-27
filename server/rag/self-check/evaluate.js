import { filterCitationsToSourceRanks } from "../source-labels.js";
import { attachRetrievedEvidence } from "../citations.js";
import {
  getCitationDocIds,
  getCitationIdentity,
  getExplicitlyAttributedCitationIdentities,
  hasCheckableCitationText,
} from "./attribution.js";
import { splitAnswerClaims } from "./claims.js";
import {
  combineRelationSupportChecks,
  evaluateAgreementClaimSupport,
  evaluateClaimAgainstCitations,
  evaluateContrastClaimSupport,
  evaluateExclusiveClaimSupport,
  evaluateNoDifferenceClaimSupport,
} from "./support.js";
import {
  haveSameValues,
  normalizeEvidenceText,
  uniqueValues,
} from "./text.js";
import { buildEvidenceGaps } from "./gaps.js";

export const evaluateClaimSupport = ({
  answerText = "",
  citations = [],
  comparisonAnalysisSummary = null,
} = {}) => {
  const claims = splitAnswerClaims(answerText, citations);
  const citationRankEntries = citations.map((citation, index) => {
    const explicitRank = Number(citation?.rank);
    const rank =
      Number.isInteger(explicitRank) && explicitRank > 0
        ? explicitRank
        : index + 1;

    return { citation, rank };
  });
  const citationRankCounts = citationRankEntries.reduce((counts, entry) => {
    counts.set(entry.rank, (counts.get(entry.rank) ?? 0) + 1);
    return counts;
  }, new Map());
  const citationByRank = new Map();

  for (const entry of citationRankEntries) {
    if (!citationByRank.has(entry.rank)) {
      citationByRank.set(entry.rank, entry.citation);
    }
  }

  if (claims.length === 0) {
    return {
      checked: false,
      supportedClaimCount: 0,
      unsupportedClaimCount: 0,
      claims: [],
    };
  }

  const checkedClaims = claims.map(({ text: claimText, sourceRanks }) => {
    const missingSourceRanks = sourceRanks.filter(
      (rank) => !citationByRank.has(rank)
    );
    const ambiguousSourceRanks = sourceRanks.filter(
      (rank) => (citationRankCounts.get(rank) ?? 0) > 1
    );
    const scopedCitations =
      sourceRanks.length > 0
        ? sourceRanks
            .map((rank) => citationByRank.get(rank))
            .filter(Boolean)
        : citations;
    const scopedCitationIdentities = new Set(
      scopedCitations.map((citation, index) =>
        getCitationIdentity(citation, index)
      )
    );
    const misattributedCitationIdentities =
      getExplicitlyAttributedCitationIdentities({
        claimText,
        citations,
      }).filter((identity) => !scopedCitationIdentities.has(identity));
    const defaultSupport = evaluateClaimAgainstCitations({
      claimText,
      citations: scopedCitations,
      documentLabelCitations: citations,
    });
    const contrastSupport = evaluateContrastClaimSupport({
      claimText,
      scopedCitations,
      sourceRanks,
    });
    const agreementSupport = evaluateAgreementClaimSupport({
      claimText,
      scopedCitations,
      sourceRanks,
    });
    const exclusiveSupport = evaluateExclusiveClaimSupport({
      allCitations: citations,
      claimText,
      scopedCitations,
      sourceRanks,
    });
    const noDifferenceSupport = evaluateNoDifferenceClaimSupport({
      claimText,
      comparisonAnalysisSummary,
      scopedCitations,
      sourceRanks,
    });
    const relationSupport = combineRelationSupportChecks([
      noDifferenceSupport,
      contrastSupport,
      agreementSupport,
      exclusiveSupport,
    ]);
    const tokenOverlap =
      relationSupport?.tokenOverlap ?? defaultSupport.tokenOverlap;
    const missingAnchors =
      relationSupport?.missingAnchors ?? defaultSupport.missingAnchors;
    const individuallySupportedSourceRanks = sourceRanks.filter((rank) => {
      if (
        !citationByRank.has(rank) ||
        (citationRankCounts.get(rank) ?? 0) !== 1
      ) {
        return false;
      }

      return evaluateClaimAgainstCitations({
        claimText,
        citations: [citationByRank.get(rank)],
        documentLabelCitations: citations,
      }).supported;
    });
    const verifiedSourceRanks = (relationSupport
      ? uniqueValues([
          ...relationSupport.supportedSourceRanks,
          ...individuallySupportedSourceRanks,
        ])
      : individuallySupportedSourceRanks
    ).sort((left, right) => left - right);
    const explicitSourcesArePrecise =
      sourceRanks.length === 0 || haveSameValues(sourceRanks, verifiedSourceRanks);
    const supported =
      sourceRanks.length > 0 &&
      missingSourceRanks.length === 0 &&
      ambiguousSourceRanks.length === 0 &&
      misattributedCitationIdentities.length === 0 &&
      explicitSourcesArePrecise &&
      (relationSupport?.supported ?? defaultSupport.supported);
    const supportedSourceRanks = supported ? verifiedSourceRanks : [];
    const supportedCitedDocIds = uniqueValues(
      supportedSourceRanks.map(
        (rank) => normalizeEvidenceText(citationByRank.get(rank)?.docId)
      )
    );

    return {
      text: claimText,
      supported,
      tokenOverlap,
      anchors: relationSupport?.anchors ?? defaultSupport.anchors,
      sourceRanks,
      citedDocIds: [...getCitationDocIds(scopedCitations)],
      verifiedSourceRanks,
      supportedSourceRanks,
      supportedCitedDocIds,
      missingSourceRanks,
      ambiguousSourceRanks,
      misattributedCitationIdentities,
      missingAnchors,
    };
  });
  const unsupportedClaimCount = checkedClaims.filter((claim) => !claim.supported).length;

  return {
    checked: true,
    supportedClaimCount: checkedClaims.length - unsupportedClaimCount,
    unsupportedClaimCount,
    claims: checkedClaims,
  };
};

export const evaluateAnswerEvidence = ({
  answerLabel = "Document answer",
  answerText = "",
  citations = [],
  comparisonAnalysisSummary = null,
  docIds = [],
  emptyAnswerReason = `${answerLabel} is empty.`,
  initialReasons = [],
  missingCheckableCitationReason = `${answerLabel} citations do not include checkable evidence text.`,
  missingCitationReason = `${answerLabel} has no citations.`,
  normalizeClaimSupport = (claimSupport) => claimSupport,
  requireCheckableCitationText = false,
  requireDocCoverage = true,
  retryRecommended = false,
  unsupportedClaimReason = (claimCount) =>
    `${claimCount} answer claim${claimCount === 1 ? "" : "s"} lacks citation support.`,
} = {}) => {
  const safeCitations = Array.isArray(citations) ? citations : [];
  const safeDocIds = Array.isArray(docIds) ? docIds : [];
  const requiredDocCoverage = requireDocCoverage
    ? Math.min(Math.max(safeDocIds.length, 1), 2)
    : 0;
  const claimSupport = normalizeClaimSupport(
    evaluateClaimSupport({
      answerText,
      citations: safeCitations,
      comparisonAnalysisSummary,
    })
  );
  const answerCitations = filterCitationsToSourceRanks({
    sourceRanks: claimSupport.claims.flatMap(
      (claim) => claim.supportedSourceRanks ?? []
    ),
    citations: safeCitations,
  });
  const citedDocIds = getCitationDocIds(answerCitations);
  const reasons = [...initialReasons];

  if (!normalizeEvidenceText(answerText)) {
    reasons.push(emptyAnswerReason);
  }

  if (safeCitations.length === 0) {
    reasons.push(missingCitationReason);
  }

  if (requireCheckableCitationText && !hasCheckableCitationText(safeCitations)) {
    reasons.push(missingCheckableCitationReason);
  }

  if (requiredDocCoverage > 0 && citedDocIds.size < requiredDocCoverage) {
    reasons.push(
      `Citations cover ${citedDocIds.size} of ${requiredDocCoverage} required documents.`
    );
  }

  if (claimSupport.unsupportedClaimCount > 0) {
    reasons.push(unsupportedClaimReason(claimSupport.unsupportedClaimCount));
  }

  const result = {
    answerLabel,
    citationCount: safeCitations.length,
    citedDocCount: citedDocIds.size,
    claimSupport,
    passed: reasons.length === 0,
    reasons,
    requiredCitationCount: 1,
    requiredDocCoverage,
    retryRecommended,
  };

  return {
    ...result,
    gaps: buildEvidenceGaps(result),
  };
};

const getEvidenceScore = (ragResult) => {
  if (!ragResult?.ok) {
    return -1;
  }

  const value = ragResult.value ?? {};
  const citations = attachRetrievedEvidence({
    citations: value.citations ?? [],
    retrievedContexts: value.retrievedContexts ?? [],
  });
  const citedDocIds = getCitationDocIds(citations);
  const answerLength = typeof value.text === "string" ? value.text.trim().length : 0;
  const claimSupport = evaluateClaimSupport({
    answerText: value.text,
    citations,
    comparisonAnalysisSummary: value.comparisonAnalysisSummary,
  });

  return (
    citations.length * 2 +
    citedDocIds.size +
    (answerLength > 0 ? 1 : 0) +
    claimSupport.supportedClaimCount -
    claimSupport.unsupportedClaimCount * 3
  );
};

export const selectBetterRagResult = ({ primary, retry } = {}) => {
  if (!retry?.ok) {
    return primary;
  }

  if (!primary?.ok) {
    return retry;
  }

  return getEvidenceScore(retry) > getEvidenceScore(primary) ? retry : primary;
};

export const evaluateDocumentEvidence = ({ ragResult, docIds = [] } = {}) => {
  if (!ragResult?.ok) {
    return {
      passed: false,
      retryRecommended: false,
      reasons: ["Document RAG failed."],
      citationCount: 0,
      citedDocCount: 0,
      requiredCitationCount: 1,
      requiredDocCoverage: Math.min(Math.max(docIds.length, 1), 2),
      gaps: [
        {
          type: "skill_failure",
          severity: "blocking",
          message: "Document RAG failed.",
        },
      ],
    };
  }

  const value = ragResult.value ?? {};
  const verificationCitations = attachRetrievedEvidence({
    citations: value.citations ?? [],
    retrievedContexts: value.retrievedContexts ?? [],
  });
  const result = evaluateAnswerEvidence({
    answerLabel: "Document answer",
    answerText: value.text,
    citations: verificationCitations,
    comparisonAnalysisSummary: value.comparisonAnalysisSummary,
    docIds,
    emptyAnswerReason: "Document answer is empty.",
    initialReasons: value.abstained
      ? ["Document RAG explicitly reported insufficient evidence."]
      : [],
    missingCitationReason: "Document answer has no citations.",
    requireDocCoverage: true,
    retryRecommended: false,
  });
  const retryRecommended = !result.passed && !value.abstained && ragResult.ok;

  return {
    ...result,
    retryRecommended,
  };
};

