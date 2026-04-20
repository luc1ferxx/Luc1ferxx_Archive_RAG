import { getMinQueryTermCoverage, getMinRelevanceScore } from "./config.js";
import {
  buildTermSet,
  extractAnchorGroups,
  normalizeSearchText,
} from "./text-utils.js";

const FALLBACK_THRESHOLD_RATIO = 0.8;

const hasEnoughQueryCoverage = (result) => {
  if (typeof result?.keywordScore !== "number") {
    return true;
  }

  return result.keywordScore >= getMinQueryTermCoverage();
};

const buildSearchableResultText = (result) =>
  [
    result?.document?.metadata?.fileName,
    result?.document?.metadata?.sectionHeading,
    result?.document?.pageContent,
  ]
    .filter(Boolean)
    .join("\n");

const getMatchedAnchorIndexes = (result, anchorGroups) => {
  if (anchorGroups.length === 0) {
    return [];
  }

  const searchableText = buildSearchableResultText(result);
  const normalizedText = normalizeSearchText(searchableText);
  const termSet = buildTermSet(searchableText);
  const matchedIndexes = [];

  for (const [index, anchorGroup] of anchorGroups.entries()) {
    const matchesPhrase = normalizedText.includes(anchorGroup.normalizedValue);
    const matchesTerms =
      anchorGroup.terms.length > 0 &&
      anchorGroup.terms.every((term) => termSet.has(term));

    if (matchesPhrase || matchesTerms) {
      matchedIndexes.push(index);
    }
  }

  return matchedIndexes;
};

const analyzeAnchorCoverage = (results, anchorGroups) => {
  if (anchorGroups.length === 0) {
    return {
      filteredResults: results,
      matchedAnchorGroups: [],
      missingAnchorGroups: [],
    };
  }

  const matchedIndexes = new Set();
  const filteredResults = [];

  for (const result of results) {
    const matchedAnchorIndexes = getMatchedAnchorIndexes(result, anchorGroups);

    if (matchedAnchorIndexes.length === 0) {
      continue;
    }

    for (const index of matchedAnchorIndexes) {
      matchedIndexes.add(index);
    }

    filteredResults.push(result);
  }

  return {
    filteredResults,
    matchedAnchorGroups: anchorGroups.filter((_group, index) =>
      matchedIndexes.has(index)
    ),
    missingAnchorGroups: anchorGroups.filter(
      (_group, index) => !matchedIndexes.has(index)
    ),
  };
};

const pickMoreCompleteAnchorAnalysis = (left, right) => {
  const leftMatchedCount = left.matchedAnchorGroups.length;
  const rightMatchedCount = right.matchedAnchorGroups.length;

  if (rightMatchedCount > leftMatchedCount) {
    return right;
  }

  if (rightMatchedCount < leftMatchedCount) {
    return left;
  }

  return right.filteredResults.length > left.filteredResults.length ? right : left;
};

const filterQualifiedResults = (results, minimumScore) =>
  results.filter(
    (result) => result.score >= minimumScore && hasEnoughQueryCoverage(result)
  );

const selectUsableResults = ({ results, queryText = "" }) => {
  const minimumScore = getMinRelevanceScore();
  const anchorGroups = extractAnchorGroups(queryText);
  const strongAnchorAnalysis = analyzeAnchorCoverage(
    filterQualifiedResults(results, minimumScore),
    anchorGroups
  );

  if (
    strongAnchorAnalysis.filteredResults.length > 0 &&
    strongAnchorAnalysis.missingAnchorGroups.length === 0
  ) {
    return {
      ...strongAnchorAnalysis,
      anchorGroups,
      usableResults: strongAnchorAnalysis.filteredResults,
      usedFallbackThreshold: false,
      failureMode: null,
    };
  }

  const fallbackAnchorAnalysis = analyzeAnchorCoverage(
    filterQualifiedResults(results, minimumScore * FALLBACK_THRESHOLD_RATIO),
    anchorGroups
  );

  if (
    fallbackAnchorAnalysis.filteredResults.length > 0 &&
    fallbackAnchorAnalysis.missingAnchorGroups.length === 0
  ) {
    return {
      ...fallbackAnchorAnalysis,
      anchorGroups,
      usableResults: fallbackAnchorAnalysis.filteredResults,
      usedFallbackThreshold: true,
      failureMode: null,
    };
  }

  const bestAnchorAnalysis = pickMoreCompleteAnchorAnalysis(
    strongAnchorAnalysis,
    fallbackAnchorAnalysis
  );

  return {
    ...bestAnchorAnalysis,
    anchorGroups,
    usableResults: [],
    usedFallbackThreshold: false,
    failureMode:
      anchorGroups.length > 0 && bestAnchorAnalysis.missingAnchorGroups.length > 0
        ? "missing_anchor_coverage"
        : "low_relevance",
  };
};

const formatAnchorLabels = (anchorGroups) =>
  anchorGroups.map((anchorGroup) => anchorGroup.label).join(", ");

const buildQaAnchorReason = (anchorGroups) =>
  `I couldn't find enough grounded evidence that specifically addresses ${formatAnchorLabels(
    anchorGroups
  )} in the uploaded documents.`;

const buildComparisonAnchorReason = ({
  anchorGroups,
  coveredDocumentCount,
  docCount,
}) => {
  if (coveredDocumentCount === 0) {
    return `I couldn't find enough grounded evidence that specifically addresses ${formatAnchorLabels(
      anchorGroups
    )} in the selected documents to compare them.`;
  }

  return `I only found strong evidence that specifically addresses ${formatAnchorLabels(
    anchorGroups
  )} in ${coveredDocumentCount} of the ${docCount} selected documents, so the comparison would be unreliable.`;
};

export const assessQaConfidence = ({ results, queryText = "" }) => {
  const selection = selectUsableResults({
    results,
    queryText,
  });

  if (selection.usableResults.length === 0) {
    return {
      confident: false,
      usableResults: [],
      reason:
        selection.failureMode === "missing_anchor_coverage"
          ? buildQaAnchorReason(
              selection.missingAnchorGroups.length > 0
                ? selection.missingAnchorGroups
                : selection.anchorGroups
            )
          : "I couldn't find enough grounded evidence in the uploaded documents to answer reliably.",
      anchorGroups: selection.anchorGroups,
      missingAnchorGroups: selection.missingAnchorGroups,
    };
  }

  return {
    confident: true,
    usableResults: selection.usableResults,
    anchorGroups: selection.anchorGroups,
    missingAnchorGroups: [],
  };
};

export const assessComparisonConfidence = ({
  docIds,
  perDocumentResults,
  queryText = "",
}) => {
  const usableResultsByDoc = new Map();
  const selectionsByDoc = new Map();
  let coveredDocumentCount = 0;

  for (const docId of docIds) {
    const results = perDocumentResults.get(docId) ?? [];
    const selection = selectUsableResults({
      results,
      queryText,
    });

    usableResultsByDoc.set(docId, selection.usableResults);
    selectionsByDoc.set(docId, selection);

    if (selection.usableResults.length > 0) {
      coveredDocumentCount += 1;
    }
  }

  const firstSelection = selectionsByDoc.get(docIds[0]) ?? {
    anchorGroups: [],
  };
  const hasAnchorSensitiveQuery = firstSelection.anchorGroups.length > 0;

  if (coveredDocumentCount === 0) {
    return {
      confident: false,
      usableResultsByDoc,
      reason: hasAnchorSensitiveQuery
        ? buildComparisonAnchorReason({
            anchorGroups: firstSelection.anchorGroups,
            coveredDocumentCount,
            docCount: docIds.length,
          })
        : "I couldn't find enough grounded evidence in the selected documents to compare them.",
    };
  }

  if (coveredDocumentCount < Math.min(2, docIds.length)) {
    return {
      confident: false,
      usableResultsByDoc,
      reason: hasAnchorSensitiveQuery
        ? buildComparisonAnchorReason({
            anchorGroups: firstSelection.anchorGroups,
            coveredDocumentCount,
            docCount: docIds.length,
          })
        : `I only found strong evidence in ${coveredDocumentCount} of the ${docIds.length} selected documents, so the comparison would be unreliable.`,
    };
  }

  return {
    confident: true,
    usableResultsByDoc,
  };
};
