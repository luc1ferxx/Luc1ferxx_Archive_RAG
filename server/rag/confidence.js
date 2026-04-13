import { getMinRelevanceScore } from "./config.js";

const FALLBACK_THRESHOLD_RATIO = 0.8;

const getUsableResults = (results) => {
  const minimumScore = getMinRelevanceScore();
  const strongResults = results.filter((result) => result.score >= minimumScore);

  if (strongResults.length > 0) {
    return strongResults;
  }

  return results.filter(
    (result) => result.score >= minimumScore * FALLBACK_THRESHOLD_RATIO
  );
};

export const assessQaConfidence = (results) => {
  const usableResults = getUsableResults(results);

  if (usableResults.length === 0) {
    return {
      confident: false,
      usableResults: [],
      reason:
        "I couldn't find enough grounded evidence in the uploaded documents to answer reliably.",
    };
  }

  return {
    confident: true,
    usableResults,
  };
};

export const assessComparisonConfidence = ({ docIds, perDocumentResults }) => {
  const usableResultsByDoc = new Map();
  let coveredDocumentCount = 0;

  for (const docId of docIds) {
    const results = perDocumentResults.get(docId) ?? [];
    const usableResults = getUsableResults(results);

    usableResultsByDoc.set(docId, usableResults);

    if (usableResults.length > 0) {
      coveredDocumentCount += 1;
    }
  }

  if (coveredDocumentCount === 0) {
    return {
      confident: false,
      usableResultsByDoc,
      reason:
        "I couldn't find enough grounded evidence in the selected documents to compare them.",
    };
  }

  if (coveredDocumentCount < Math.min(2, docIds.length)) {
    return {
      confident: false,
      usableResultsByDoc,
      reason: `I only found strong evidence in ${coveredDocumentCount} of the ${docIds.length} selected documents, so the comparison would be unreliable.`,
    };
  }

  return {
    confident: true,
    usableResultsByDoc,
  };
};
