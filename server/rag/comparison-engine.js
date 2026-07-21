const NEAR_DUPLICATE_TERM_JACCARD = 0.75;
const NEAR_DUPLICATE_SENTENCE_OVERLAP = 0.6;
const STRONG_NEAR_DUPLICATE_TERM_JACCARD = 0.85;
const STRONG_NEAR_DUPLICATE_SENTENCE_OVERLAP = 0.75;
const REQUIRE_SIGNAL_PATTERN =
  /\b(?:require(?:d|s|ing)?|must|mandatory|mandate(?:d|s|ing)?|need(?:ed|s|ing)?|necessary)\b/i;
const OPTIONAL_SIGNAL_PATTERN =
  /\b(?:optional|unnecessary|not\s+(?:required|necessary|mandatory)|does?\s+not\s+require|independent(?:ly)?\s+of|free\s+from|exempt(?:ed)?\s+from)\b/i;
const ALLOW_SIGNAL_PATTERN =
  /\b(?:allow(?:ed|s|ing)?|permit(?:s|ted|ting)?|may)\b/i;
const PROHIBIT_SIGNAL_PATTERN =
  /\b(?:prohibit(?:ed|s|ing)?|forbid(?:s|den|ding)?|disallow(?:ed|s|ing)?|not\s+(?:allowed|permitted)|cannot|can't|must\s+not|may\s+not)\b/i;

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

const haveSameSetValues = (leftSet, rightSet) =>
  leftSet.size === rightSet.size &&
  [...leftSet].every((value) => rightSet.has(value));

const haveSameNumericBindings = (leftBindings, rightBindings) =>
  leftBindings.size === rightBindings.size &&
  [...leftBindings].every(([sentence, leftSignatures]) => {
    const rightSignatures = rightBindings.get(sentence);

    return Boolean(
      rightSignatures && haveSameSetValues(leftSignatures, rightSignatures)
    );
  });

const hasNumericBindingConflict = (leftBindings, rightBindings) =>
  [...leftBindings].some(([sentence, leftSignatures]) => {
    const rightSignatures = rightBindings.get(sentence);

    return Boolean(
      rightSignatures && !haveSameSetValues(leftSignatures, rightSignatures)
    );
  });

const getSemanticSignals = (text = "") => {
  const signals = new Set();

  if (REQUIRE_SIGNAL_PATTERN.test(text) && !OPTIONAL_SIGNAL_PATTERN.test(text)) {
    signals.add("require");
  }
  if (OPTIONAL_SIGNAL_PATTERN.test(text)) {
    signals.add("optional");
  }
  if (ALLOW_SIGNAL_PATTERN.test(text) && !PROHIBIT_SIGNAL_PATTERN.test(text)) {
    signals.add("allow");
  }
  if (PROHIBIT_SIGNAL_PATTERN.test(text)) {
    signals.add("prohibit");
  }

  return signals;
};

const hasOpposingSemanticSignals = (leftSignals, rightSignals) =>
  (leftSignals.has("require") && rightSignals.has("optional")) ||
  (leftSignals.has("optional") && rightSignals.has("require")) ||
  (leftSignals.has("allow") && rightSignals.has("prohibit")) ||
  (leftSignals.has("prohibit") && rightSignals.has("allow"));

const hasComparableEvidence = (entry = {}) =>
  entry.hasComparableEvidence ??
  (entry.results?.length > 0 && entry.canonicalSentenceSet?.size > 0);

const analyzePair = (leftEntry, rightEntry) => {
  const leftNumericBindings = leftEntry.numericBindingsBySentence ?? new Map();
  const rightNumericBindings = rightEntry.numericBindingsBySentence ?? new Map();
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
  const leftSemanticSignals = getSemanticSignals(leftEntry.evidenceText);
  const rightSemanticSignals = getSemanticSignals(rightEntry.evidenceText);
  const semanticConflict = hasOpposingSemanticSignals(
    leftSemanticSignals,
    rightSemanticSignals
  );
  const numericBindingConflict = hasNumericBindingConflict(
    leftNumericBindings,
    rightNumericBindings
  );
  const exactEvidenceMatch =
    hasComparableEvidence(leftEntry) &&
    hasComparableEvidence(rightEntry) &&
    haveSameSetValues(
      leftEntry.canonicalSentenceSet,
      rightEntry.canonicalSentenceSet
    ) &&
    haveSameSetValues(leftEntry.numericTokenSet, rightEntry.numericTokenSet) &&
    haveSameNumericBindings(leftNumericBindings, rightNumericBindings);
  const nearDuplicate =
    termJaccard >= NEAR_DUPLICATE_TERM_JACCARD &&
    sentenceOverlap >= NEAR_DUPLICATE_SENTENCE_OVERLAP;
  const strongNearDuplicate =
    termJaccard >= STRONG_NEAR_DUPLICATE_TERM_JACCARD &&
    sentenceOverlap >= STRONG_NEAR_DUPLICATE_SENTENCE_OVERLAP;
  const explicitConflict =
    nearDuplicate &&
    (numericTokensOnlyInLeft.length > 0 ||
      numericTokensOnlyInRight.length > 0 ||
      numericBindingConflict ||
      semanticConflict);

  return {
    leftDocId: leftEntry.docId,
    leftFileName: leftEntry.fileName,
    rightDocId: rightEntry.docId,
    rightFileName: rightEntry.fileName,
    termJaccard: roundScore(termJaccard),
    sentenceOverlap: roundScore(sentenceOverlap),
    nearDuplicate,
    strongNearDuplicate,
    exactEvidenceMatch,
    explicitConflict,
    numericBindingConflict,
    semanticConflict,
    numericTokensOnlyInLeft,
    numericTokensOnlyInRight,
  };
};

export const analyzeComparison = ({ alignment }) => {
  const evidenceCounts = alignment.perDocument.map((entry) => entry.results.length);
  const maxEvidenceCount = evidenceCounts.length > 0 ? Math.max(...evidenceCounts) : 0;
  const minEvidenceCount = evidenceCounts.length > 0 ? Math.min(...evidenceCounts) : 0;
  const comparableEntries = alignment.perDocument.filter(hasComparableEvidence);
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
    (pair) => pair.exactEvidenceMatch && !pair.explicitConflict
  );
  const shouldShortCircuitNoMaterialDifference =
    alignment.missingDocuments.length === 0 &&
    comparableEntries.length === alignment.perDocument.length &&
    pairwiseAnalysis.length > 0 &&
    pairwiseAnalysis.every(
      (pair) => pair.exactEvidenceMatch && !pair.explicitConflict
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
