const NEAR_DUPLICATE_TERM_JACCARD = 0.75;
const NEAR_DUPLICATE_SENTENCE_OVERLAP = 0.6;
const STRONG_NEAR_DUPLICATE_TERM_JACCARD = 0.85;
const STRONG_NEAR_DUPLICATE_SENTENCE_OVERLAP = 0.75;

const roundScore = (value) => Number(value.toFixed(4));

const countSharedValues = (leftSet, rightSet) => {
  let sharedCount = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      sharedCount += 1;
    }
  }

  return sharedCount;
};

const getJaccardSimilarity = (leftSet, rightSet) => {
  const unionSize = new Set([...leftSet, ...rightSet]).size;

  if (unionSize === 0) {
    return 1;
  }

  return countSharedValues(leftSet, rightSet) / unionSize;
};

const getOverlapCoefficient = (leftSet, rightSet) => {
  const minimumSize = Math.min(leftSet.size, rightSet.size);

  if (minimumSize === 0) {
    return 0;
  }

  return countSharedValues(leftSet, rightSet) / minimumSize;
};

const getSortedSetDifference = (leftSet, rightSet) =>
  [...leftSet].filter((value) => !rightSet.has(value)).sort((left, right) => left.localeCompare(right));

const analyzePair = (leftEntry, rightEntry) => {
  const termJaccard = getJaccardSimilarity(leftEntry.termSet, rightEntry.termSet);
  const sentenceOverlap = getOverlapCoefficient(
    leftEntry.canonicalSentenceSet,
    rightEntry.canonicalSentenceSet
  );
  const numericTokensOnlyInLeft = getSortedSetDifference(
    leftEntry.numericTokenSet,
    rightEntry.numericTokenSet
  );
  const numericTokensOnlyInRight = getSortedSetDifference(
    rightEntry.numericTokenSet,
    leftEntry.numericTokenSet
  );
  const nearDuplicate =
    termJaccard >= NEAR_DUPLICATE_TERM_JACCARD &&
    sentenceOverlap >= NEAR_DUPLICATE_SENTENCE_OVERLAP;
  const strongNearDuplicate =
    termJaccard >= STRONG_NEAR_DUPLICATE_TERM_JACCARD &&
    sentenceOverlap >= STRONG_NEAR_DUPLICATE_SENTENCE_OVERLAP;
  const explicitConflict =
    nearDuplicate &&
    (numericTokensOnlyInLeft.length > 0 || numericTokensOnlyInRight.length > 0);

  return {
    leftDocId: leftEntry.docId,
    leftFileName: leftEntry.fileName,
    rightDocId: rightEntry.docId,
    rightFileName: rightEntry.fileName,
    termJaccard: roundScore(termJaccard),
    sentenceOverlap: roundScore(sentenceOverlap),
    nearDuplicate,
    strongNearDuplicate,
    explicitConflict,
    numericTokensOnlyInLeft,
    numericTokensOnlyInRight,
  };
};

export const analyzeComparison = ({ alignment }) => {
  const evidenceCounts = alignment.perDocument.map((entry) => entry.results.length);
  const maxEvidenceCount = evidenceCounts.length > 0 ? Math.max(...evidenceCounts) : 0;
  const minEvidenceCount = evidenceCounts.length > 0 ? Math.min(...evidenceCounts) : 0;
  const comparableEntries = alignment.perDocument.filter((entry) => entry.results.length > 0);
  const pairwiseAnalysis = [];

  for (let leftIndex = 0; leftIndex < comparableEntries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparableEntries.length; rightIndex += 1) {
      pairwiseAnalysis.push(
        analyzePair(comparableEntries[leftIndex], comparableEntries[rightIndex])
      );
    }
  }

  const nearDuplicatePairs = pairwiseAnalysis.filter((pair) => pair.nearDuplicate);
  const explicitConflictPairs = nearDuplicatePairs.filter((pair) => pair.explicitConflict);
  const likelyNoMaterialDifferencePairs = pairwiseAnalysis.filter(
    (pair) => pair.strongNearDuplicate && !pair.explicitConflict
  );
  const shouldShortCircuitNoMaterialDifference =
    pairwiseAnalysis.length > 0 &&
    pairwiseAnalysis.every(
      (pair) => pair.strongNearDuplicate && !pair.explicitConflict
    );

  return {
    sharedTerms: alignment.sharedTerms,
    missingDocuments: alignment.missingDocuments,
    evidenceBalance:
      maxEvidenceCount - minEvidenceCount > 1 ? "skewed" : "balanced",
    pairwiseAnalysis,
    nearDuplicatePairs,
    explicitConflictPairs,
    likelyNoMaterialDifferencePairs,
    shouldShortCircuitNoMaterialDifference,
    perDocumentSummary: alignment.perDocument.map((entry) => ({
      docId: entry.docId,
      fileName: entry.fileName,
      evidenceCount: entry.results.length,
      topScore: roundScore(entry.topScore),
      focusTerms: entry.focusTerms,
    })),
  };
};
