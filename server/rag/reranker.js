import { getRerankWeight, isRerankEnabled } from "./config.js";
import {
  buildTermSet,
  extractAnchorGroups,
  extractMeaningfulTokens,
  normalizeSearchText,
} from "./text-utils.js";

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const toFiniteNumber = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
};

const normalizeTopK = (topK, fallbackValue) => {
  const parsedValue = Math.floor(Number(topK));
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallbackValue;
};

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

const buildSearchableText = (result) =>
  [
    result?.document?.metadata?.fileName,
    result?.document?.metadata?.sectionHeading,
    result?.document?.pageContent,
  ]
    .filter(Boolean)
    .join("\n");

const buildFieldText = (result) =>
  [result?.document?.metadata?.fileName, result?.document?.metadata?.sectionHeading]
    .filter(Boolean)
    .join("\n");

const countTermOverlap = (queryTerms, termSet) => {
  if (queryTerms.length === 0) {
    return 0;
  }

  let overlapCount = 0;

  for (const term of queryTerms) {
    if (termSet.has(term)) {
      overlapCount += 1;
    }
  }

  return overlapCount / queryTerms.length;
};

const buildQuerySignals = (queryText) => {
  const queryTerms = uniqueValues(extractMeaningfulTokens(queryText));
  const anchors = extractAnchorGroups(queryText);
  const normalizedQuery = normalizeSearchText(queryText);
  const meaningfulPhrase = queryTerms.join(" ");
  const phrases = uniqueValues([
    ...anchors.map((anchor) => anchor.normalizedValue),
    meaningfulPhrase.split(" ").length >= 2 ? meaningfulPhrase : "",
    normalizedQuery.split(" ").length >= 2 ? normalizedQuery : "",
  ]);

  return {
    anchors,
    phrases,
    queryTerms,
  };
};

const getPhraseScore = ({ normalizedText, termSet, signals }) => {
  if (signals.phrases.some((phrase) => normalizedText.includes(phrase))) {
    return 1;
  }

  if (signals.anchors.length === 0) {
    return 0;
  }

  const matchedAnchorCount = signals.anchors.filter((anchor) => {
    if (normalizedText.includes(anchor.normalizedValue)) {
      return true;
    }

    return anchor.terms.length > 0 && anchor.terms.every((term) => termSet.has(term));
  }).length;

  return matchedAnchorCount / signals.anchors.length;
};

const getFieldScore = ({ result, signals }) => {
  const fieldText = buildFieldText(result);

  if (!fieldText) {
    return 0;
  }

  const normalizedFieldText = normalizeSearchText(fieldText);
  const fieldTermSet = buildTermSet(fieldText);
  const phraseScore = signals.phrases.some((phrase) =>
    normalizedFieldText.includes(phrase)
  )
    ? 1
    : 0;
  const overlapScore = countTermOverlap(signals.queryTerms, fieldTermSet);

  return Math.max(phraseScore, overlapScore);
};

const buildRawRerankScore = ({ result, normalizedOriginalScore, signals }) => {
  const searchableText = buildSearchableText(result);
  const normalizedText = normalizeSearchText(searchableText);
  const termSet = buildTermSet(searchableText);
  const overlapScore = countTermOverlap(signals.queryTerms, termSet);
  const phraseScore = getPhraseScore({
    normalizedText,
    termSet,
    signals,
  });
  const fieldScore = getFieldScore({
    result,
    signals,
  });

  return clamp01(
    overlapScore * 0.45 +
      phraseScore * 0.25 +
      fieldScore * 0.2 +
      normalizedOriginalScore * 0.1
  );
};

export const rerankResults = ({ queryText = "", results = [], topK } = {}) => {
  const safeResults = Array.isArray(results) ? results : [];
  const safeTopK = normalizeTopK(topK, safeResults.length);

  if (!isRerankEnabled()) {
    return safeResults.slice(0, safeTopK);
  }

  if (safeResults.length === 0 || safeTopK === 0) {
    return [];
  }

  const rerankWeight = getRerankWeight();
  const signals = buildQuerySignals(queryText);
  const originalScores = safeResults.map((result) =>
    toFiniteNumber(result?.score, 0)
  );
  const maximumOriginalScore = Math.max(0, ...originalScores);
  const scoredResults = safeResults.map((result, index) => {
    const originalScore = originalScores[index];
    const normalizedOriginalScore =
      maximumOriginalScore > 0 ? originalScore / maximumOriginalScore : 0;
    const rawRerankScore = buildRawRerankScore({
      result,
      normalizedOriginalScore: clamp01(normalizedOriginalScore),
      signals,
    });

    return {
      result,
      index,
      originalScore,
      rawRerankScore,
    };
  });
  const maximumRawRerankScore = Math.max(
    0,
    ...scoredResults.map((entry) => entry.rawRerankScore)
  );

  return scoredResults
    .map((entry) => {
      const rerankScore =
        maximumRawRerankScore > 0
          ? clamp01(entry.rawRerankScore / maximumRawRerankScore)
          : 0;
      const mixedScore =
        entry.originalScore * (1 - rerankWeight) + rerankScore * rerankWeight;

      return {
        ...entry.result,
        originalScore: entry.originalScore,
        rerankScore,
        score: mixedScore,
        __rerankIndex: entry.index,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.rerankScore - left.rerankScore ||
        right.originalScore - left.originalScore ||
        left.__rerankIndex - right.__rerankIndex
    )
    .slice(0, safeTopK)
    .map(({ __rerankIndex, ...result }) => result);
};
