import {
  getMinQaQueryTermCoverage,
  getMinQueryTermCoverage,
  getMinRelevanceScore,
  getCrossEncoderScoreScale,
  getQaMinRerankProbability,
  getQaPartialCoverageFloor,
  isQaAnswerVerdictEnabled,
} from "./config.js";
import { getAdmissionScore, getResultKey } from "./citations.js";
import {
  buildTermSet,
  extractAnchorGroups,
  extractMeaningfulTokens,
  normalizeSearchText,
  tokenize,
} from "./text-utils.js";

const FALLBACK_THRESHOLD_RATIO = 0.8;

// Plural-insensitive matching, so "ceilings" still names the ceiling.
const stemTerm = (term) =>
  term.length > 3 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;

const isContentToken = (token) => extractMeaningfulTokens(token)[0] === token;

// Words that modify a head word without naming a topic of their own: "how
// many annual leave days" asks about annual leave, and "10 paid annual leave
// days" has not replaced "many". Only a topic-naming word can be the asked
// word a rival replaces.
const NON_TOPICAL_MODIFIERS = new Set([
  "all", "another", "any", "best", "better", "big", "bigger", "biggest", "both",
  "certain", "common", "current", "each", "either", "every", "few", "fewer",
  "first", "general", "given", "good", "high", "higher", "highest", "large",
  "larger", "largest", "last", "least", "less", "long", "low", "lower", "lowest",
  "main", "many", "me", "more", "most", "much", "my", "neither", "new", "next",
  "old", "only", "other", "overall", "own", "particular", "previous", "prior",
  "recent", "several", "short", "small", "smaller", "smallest", "so", "some",
  "specific", "such", "too", "total", "typical", "us", "usual", "various", "very",
  "worse", "worst", "been", "being", "get", "got", "give", "make", "made",
  "take", "taken", "use", "used", "using",
]);

// Adjacent content-word pairs, never across a sentence or line break.
const collectContentBigrams = (text) =>
  String(text ?? "")
    .split(/[.;:!?\n。；：！？]+/)
    .flatMap((segment) => {
      const tokens = tokenize(segment);

      return tokens.slice(1).flatMap((token, index) =>
        isContentToken(tokens[index]) && isContentToken(token) ? [[tokens[index], token]] : []
      );
    });

const editDistanceAtMost = (left, right, limit) => {
  if (Math.abs(left.length - right.length) > limit) {
    return false;
  }

  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];

    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }

    if (Math.min(...current) > limit) {
      return false;
    }

    previous = current;
  }

  return previous[right.length] <= limit;
};

// A misspelled query word ("knowedge graph" against "knowledge graph") is the
// same word, not a rival.
const isSpellingVariant = (asked, found) =>
  /^[a-z]{5,}$/.test(asked) && /^[a-z]{5,}$/.test(found) && editDistanceAtMost(asked, found, 2);

/**
 * The difference between a chunk that answers a question in other words and
 * one about a neighbouring thing: the question pairs a word with a head word
 * ("parental leave", "amber ceiling"), and the chunk has the head word with a
 * different word in that place ("annual leave", "cobalt ceiling") and never
 * the asked one. Returns the first such pair, or null.
 *
 * Only single-document QA reads it, and only to refuse a chunk in the partial
 * coverage band, which the coverage floor alone would refuse too; a false
 * positive therefore costs nothing against the stricter gate. It is lexical:
 * a hyponym ("neural network" against "recurrent network") also counts as a
 * rival.
 */
export const findQueryTermSubstitution = (queryText, evidenceText) => {
  const queryStems = new Set(extractMeaningfulTokens(queryText).map(stemTerm));
  const evidenceStems = new Set(extractMeaningfulTokens(evidenceText).map(stemTerm));
  const evidenceBigrams = collectContentBigrams(evidenceText);

  for (const [asked, head] of collectContentBigrams(queryText)) {
    if (
      NON_TOPICAL_MODIFIERS.has(asked) ||
      evidenceStems.has(stemTerm(asked)) ||
      !evidenceStems.has(stemTerm(head))
    ) {
      continue;
    }

    const rival = evidenceBigrams.find(
      ([found, evidenceHead]) =>
        stemTerm(evidenceHead) === stemTerm(head) &&
        !queryStems.has(stemTerm(found)) &&
        !isSpellingVariant(asked, found)
    );

    if (rival) {
      return { asked: `${asked} ${head}`, found: rival.join(" ") };
    }
  }

  return null;
};

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
//
// Single-document QA has its own, narrower relief (partialCoverage), open only
// with RAG_QA_ANSWER_VERDICT on: a chunk between the partial floor and the
// coverage floor is admitted unless it swaps a query word for a rival on the
// same head word (findQueryTermSubstitution). That separates the two reasons a
// chunk misses query terms -- it says the same thing in other words, or it is
// about a neighbouring thing -- which the coverage fraction alone cannot.
// Whether the chunk actually answers is then the answer model's call
// (QA_NOT_IN_EVIDENCE_MARKER in answer-verdict.js).
const hasEnoughQueryCoverage = (
  result,
  {
    allowSemanticBypass = false,
    minCoverage = getMinQueryTermCoverage(),
    partialCoverage = null,
  } = {}
) => {
  if (typeof result?.keywordScore !== "number") {
    return true;
  }

  if (result.keywordScore >= minCoverage) {
    return true;
  }

  if (partialCoverage && result.keywordScore >= partialCoverage.floor) {
    return !findQueryTermSubstitution(
      partialCoverage.queryText,
      buildSubstitutionEvidenceText(result)
    );
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

// The file name is left out: "cobalt.pdf" names the file, not the topic of
// a clause.
function buildSubstitutionEvidenceText(result) {
  return [result?.document?.metadata?.sectionHeading, result?.document?.pageContent]
    .filter(Boolean)
    .join("\n");
}

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

// QA and comparison read separate coverage floors: comparison keeps
// RAG_MIN_QUERY_TERM_COVERAGE (its abstention cases depend on it), QA reads
// RAG_MIN_QA_QUERY_TERM_COVERAGE.
const selectUsableResults = ({
  results,
  queryText = "",
  allowSemanticBypass = false,
  minCoverage = getMinQueryTermCoverage(),
  partialCoverageFloor = null,
}) => {
  const minimumScore = getMinRelevanceScore();
  const coverageOptions = {
    allowSemanticBypass,
    minCoverage,
    partialCoverage:
      partialCoverageFloor !== null && partialCoverageFloor < minCoverage
        ? { floor: partialCoverageFloor, queryText }
        : null,
  };
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

/** A cross-encoder score as a relevance probability. */
export const toRerankProbability = (score) =>
  getCrossEncoderScoreScale() === "probabilities" ? Number(score) : 1 / (1 + Math.exp(-Number(score)));

// The reranker read the question and the chunk together, so its probability
// judges relevance where query-term coverage can only count shared words. A
// chunk clears the gate when that probability does; anchors (identifiers,
// quoted phrases) must still appear, as on the lexical path.
const selectByRerankProbability = ({ minProbability, queryText, results }) => {
  const anchorGroups = extractAnchorGroups(queryText);
  const analysis = analyzeAnchorCoverage(
    results.filter((result) => toRerankProbability(result.crossEncoderScore) >= minProbability),
    anchorGroups
  );

  if (analysis.filteredResults.length > 0 && analysis.missingAnchorGroups.length === 0) {
    return { ...analysis, anchorGroups, failureMode: null, usableResults: analysis.filteredResults };
  }

  return {
    ...analysis,
    anchorGroups,
    failureMode:
      anchorGroups.length > 0 && analysis.missingAnchorGroups.length > 0 ? "missing_anchor_coverage" : "low_relevance",
    usableResults: [],
  };
};

// The partial coverage band opens only with RAG_QA_ANSWER_VERDICT on, since it
// admits chunks whose answer only the model can confirm.
// evidenceRequirementCount is how many parts the query decomposer split the
// question into. The partial coverage band is for a single-part question: in a
// multi-part one ("when does it take effect and which regions does it apply
// to"), a chunk matching only the topic word answers none of the parts, and low
// coverage is what drives the gap planner's per-part suggestions.
export const assessQaConfidence = ({ results, queryText = "", evidenceRequirementCount = 1 }) => {
  const minCoverage = getMinQaQueryTermCoverage();
  const minRerankProbability = getQaMinRerankProbability();
  const rerankGate =
    minRerankProbability !== null &&
    results.length > 0 &&
    results.every((result) => typeof result?.crossEncoderScore === "number");
  const selection = rerankGate
    ? selectByRerankProbability({ minProbability: minRerankProbability, queryText, results })
    : selectUsableResults({
        minCoverage,
        partialCoverageFloor:
          evidenceRequirementCount <= 1 && isQaAnswerVerdictEnabled() ? getQaPartialCoverageFloor() : null,
        results,
        queryText,
      });
  const gate = rerankGate ? "rerank" : "lexical";

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
      gate,
      missingAnchorGroups: selection.missingAnchorGroups,
    };
  }

  return {
    confident: true,
    gate,
    usableResults: selection.usableResults,
    anchorGroups: selection.anchorGroups,
    missingAnchorGroups: [],
    // Admitted through the partial coverage band rather than the floor.
    partialCoverageResultCount: selection.usableResults.filter(
      (result) => typeof result?.keywordScore === "number" && result.keywordScore < minCoverage
    ).length,
  };
};

/**
 * The chunks the QA answer model sees once the gate is confident: the ones the
 * gate admitted, then further candidates in retrieval order, up to `limit`.
 *
 * The coverage floor judges each chunk alone, so a confident question still
 * lost the evidence paragraphs worded differently from it: on QASPER dev 69%
 * of evidence paragraphs were among the candidates and 24% reached the model.
 * Whether to answer stays the gate's call; this only decides what the model
 * reads. A further candidate must still clear the relevance fallback floor,
 * reach `minCoverage`, name one of the question's anchors when it has any, and
 * not replace a query word with a rival (findQueryTermSubstitution).
 */
export const selectQaContext = ({ confidence, limit, minCoverage, queryText = "", results }) => {
  if (!confidence?.confident) {
    return [];
  }

  const admitted = confidence.usableResults;
  const admittedKeys = new Set(admitted.map((result) => getResultKey(result)));
  const anchorGroups = confidence.anchorGroups ?? [];
  const minimumScore = getMinRelevanceScore() * FALLBACK_THRESHOLD_RATIO;
  const extras = results.filter(
    (result) =>
      !admittedKeys.has(getResultKey(result)) &&
      getAdmissionScore(result) >= minimumScore &&
      (typeof result?.keywordScore !== "number" || result.keywordScore >= minCoverage) &&
      (anchorGroups.length === 0 || getMatchedAnchorIndexes(result, anchorGroups).length > 0) &&
      !findQueryTermSubstitution(queryText, buildSubstitutionEvidenceText(result))
  );

  return [...admitted, ...extras].slice(0, Math.max(limit, admitted.length));
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
