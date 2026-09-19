import { getMinQueryTermCoverage, getMinRelevanceScore } from "./config.js";
import { getAdmissionScore } from "./citations.js";
import {
  buildTermSet,
  extractAnchorGroups,
  normalizeSearchText,
} from "./text-utils.js";

const FALLBACK_THRESHOLD_RATIO = 0.8;

// Query-term coverage is a purely lexical measure, so on its own it vetoes results
// that hybrid retrieval was built to find: the ones where the document says the
// same thing in different words. Asking "compare liability caps" of a clause
// reading "shall not exceed the fees paid" matches only "liability", giving 1/2
// coverage against a 0.51 default. Every naturally phrased comparison question
// measured landed at exactly 0.50 and was rejected before the model was ever
// called.
//
// The bypass is deliberately limited to comparison, because in single-document QA
// low coverage carries real information: it marks a chunk that addresses only part
// of a multi-aspect question, which is what drives the gap-suggestion machinery
// ("when does this take effect AND which regions"). Relaxing it there made a
// correct abstention disappear. Comparison is different in kind -- the words naming
// the task and the documents ("compare", "two", "contracts", "caps") sit in the
// denominator and can never appear in a clause -- so the same measure means
// something different and is structurally biased against exactly the questions the
// product exists to answer.
//
// The bar reused here is getMinRelevanceScore() rather than a new tunable: if
// semantic similarity alone clears the bar the system already uses to call a result
// relevant, requiring lexical agreement on top is asking the same question twice
// and taking the worse answer.
//
// Keyed on vectorScore, not score, because score can be inflated by the keyword
// component in combined mode -- which would let a weak lexical match bootstrap
// itself past a gate that exists to judge lexical matches. Results carrying no
// vectorScore keep the strict behaviour.
//
// This does NOT weaken the anchor check: a query naming a specific identifier is
// still rejected when the identifier is absent, by analyzeAnchorCoverage, which
// runs after this filter and is tested independently.
const hasEnoughQueryCoverage = (result, { allowSemanticBypass = false } = {}) => {
  if (typeof result?.keywordScore !== "number") {
    return true;
  }

  if (result.keywordScore >= getMinQueryTermCoverage()) {
    return true;
  }

  return (
    allowSemanticBypass &&
    typeof result?.vectorScore === "number" &&
    result.vectorScore >= getMinRelevanceScore()
  );
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

// The relevance floor is applied to the evidence-admission signal, never to the
// fusion `score`. RRF fusion scales its rank-sum into [0, 1] to rank candidates;
// a chunk that ranks first on both routes gets score 1.0 regardless of how weak
// its raw similarity is, so gating admission on `score` would let fusion position
// stand in for retrieval strength. getAdmissionScore reads the strongest bounded
// raw signal (dense cosine or query-term coverage); a candidate carrying no raw
// signal admits at 0 and is rejected -- fail closed.
const filterQualifiedResults = (results, minimumScore, coverageOptions) =>
  results.filter(
    (result) =>
      getAdmissionScore(result) >= minimumScore &&
      hasEnoughQueryCoverage(result, coverageOptions)
  );

const selectUsableResults = ({
  results,
  queryText = "",
  allowSemanticBypass = false,
}) => {
  const minimumScore = getMinRelevanceScore();
  const coverageOptions = { allowSemanticBypass };
  const anchorGroups = extractAnchorGroups(queryText);
  const strongAnchorAnalysis = analyzeAnchorCoverage(
    filterQualifiedResults(results, minimumScore, coverageOptions),
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
    filterQualifiedResults(
      results,
      minimumScore * FALLBACK_THRESHOLD_RATIO,
      coverageOptions
    ),
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
      // Only comparison opts in: see hasEnoughQueryCoverage for why the same
      // lexical measure means something different here than in single-document QA.
      allowSemanticBypass: true,
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
