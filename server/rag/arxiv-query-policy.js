import {
  buildExternalQueryPolicy,
  buildExternalQuerySensitiveTerms,
  EXTERNAL_QUERY_STOP_TERMS,
  getExternalQueryInternalIdentifiers,
  isSearchableExternalQueryTerm,
  normalizeExternalQueryTerm,
  splitExternalQueryTerms,
} from "./external-query-policy.js";
import { extractMeaningfulTokens } from "./text-utils.js";

const DEFAULT_TOPIC_TAG_LIMIT = 4;
const MAX_KEYPHRASE_TOKENS = 3;
const DEFAULT_RELEVANCE_TERM_LIMIT = 8;
const MIN_RELEVANCE_MATCHED_TERMS = 2;
const MIN_RELEVANCE_SCORE = 2.5;

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeTopicTerm = normalizeExternalQueryTerm;
const splitTopicTerms = splitExternalQueryTerms;
const isSearchableTopicTerm = isSearchableExternalQueryTerm;

const uniq = (values) => [...new Set(values.filter(Boolean))];

const getProfile = (document = {}) =>
  document.profile && typeof document.profile === "object"
    ? document.profile
    : {
        tags: document.tags ?? [],
      };

const isSafeTopicCandidate = ({ rawValue, sensitiveTerms, terms }) => {
  if (terms.length === 0 || terms.length > MAX_KEYPHRASE_TOKENS) {
    return false;
  }

  if (getExternalQueryInternalIdentifiers(rawValue).length > 0) {
    return false;
  }

  const normalizedPhrase = terms.join(" ");

  if (sensitiveTerms.has(normalizedPhrase)) {
    return false;
  }

  return terms.every(
    (term) =>
      isSearchableTopicTerm(term) &&
      !EXTERNAL_QUERY_STOP_TERMS.has(term) &&
      !sensitiveTerms.has(term)
  );
};

const addTopicCandidate = (
  candidates,
  {
    position = 0,
    rawValue,
    source,
    sourceWeight,
  } = {},
  sensitiveTerms
) => {
  const terms = splitTopicTerms(rawValue);

  if (
    !isSafeTopicCandidate({
      rawValue,
      sensitiveTerms,
      terms,
    })
  ) {
    return;
  }

  const value = terms.join(" ");
  const existingCandidate = candidates.get(value) ?? {
    firstPosition: position,
    score: 0,
    sources: new Set(),
    terms,
    value,
  };

  const keyphraseBonus = Math.max(0, terms.length - 1) * 0.6;
  const positionBonus = 1 / (position + 1);

  existingCandidate.score += sourceWeight + keyphraseBonus + positionBonus;
  existingCandidate.firstPosition = Math.min(
    existingCandidate.firstPosition,
    position
  );
  existingCandidate.sources.add(source);
  candidates.set(value, existingCandidate);
};

const addSummaryKeyphraseCandidates = ({ candidates, profile, sensitiveTerms }) => {
  const tokens = extractMeaningfulTokens(profile.summary ?? "")
    .map(normalizeTopicTerm)
    .filter(Boolean);

  tokens.forEach((token, index) => {
    for (
      let phraseLength = Math.min(MAX_KEYPHRASE_TOKENS, tokens.length - index);
      phraseLength >= 1;
      phraseLength -= 1
    ) {
      const phraseTokens = tokens.slice(index, index + phraseLength);

      addTopicCandidate(
        candidates,
        {
          position: index,
          rawValue: phraseTokens.join(" "),
          source: "summary",
          sourceWeight: phraseLength === 1 ? 0.8 : phraseLength * 1.35,
        },
        sensitiveTerms
      );
    }
  });
};

const addTagCandidates = ({ candidates, profile, sensitiveTerms }) => {
  toArray(profile.tags).forEach((tag, index) => {
    addTopicCandidate(
      candidates,
      {
        position: index,
        rawValue: tag,
        source: "tag",
        sourceWeight: 8 - index * 0.15,
      },
      sensitiveTerms
    );
  });
};

export const rankArxivTopicCandidatesFromDocumentProfile = (
  document = {},
  { limit = DEFAULT_TOPIC_TAG_LIMIT } = {}
) => {
  const profile = getProfile(document);
  const sensitiveTerms = buildExternalQuerySensitiveTerms({
    document,
    profile,
  });
  const candidates = new Map();

  addTagCandidates({
    candidates,
    profile,
    sensitiveTerms,
  });
  addSummaryKeyphraseCandidates({
    candidates,
    profile,
    sensitiveTerms,
  });

  const selectedTerms = [];
  const selectedTermSet = new Set();

  for (const candidate of [...candidates.values()].sort(
    (left, right) =>
      right.score - left.score ||
      right.terms.length - left.terms.length ||
      left.firstPosition - right.firstPosition ||
      left.value.localeCompare(right.value)
  )) {
    for (const term of candidate.terms) {
      if (selectedTermSet.has(term)) {
        continue;
      }

      selectedTerms.push(term);
      selectedTermSet.add(term);

      if (selectedTerms.length >= limit) {
        return selectedTerms;
      }
    }
  }

  return selectedTerms;
};

export const buildArxivTopicFromDocumentProfile = (
  document = {},
  { tagLimit = DEFAULT_TOPIC_TAG_LIMIT } = {}
) => {
  const terms = rankArxivTopicCandidatesFromDocumentProfile(document, {
    limit: tagLimit,
  });
  const queryPolicy = buildExternalQueryPolicy({
    candidateQuery: terms.join(" "),
    document,
    profile: getProfile(document),
  });

  return queryPolicy.sanitizedQuery;
};

export const buildArxivQueryPolicyFromDocumentProfile = (
  document = {},
  { accessScope = {}, tagLimit = DEFAULT_TOPIC_TAG_LIMIT } = {}
) => {
  const terms = rankArxivTopicCandidatesFromDocumentProfile(document, {
    limit: tagLimit,
  });

  return buildExternalQueryPolicy({
    accessScope,
    candidateQuery: terms.join(" "),
    document,
    profile: getProfile(document),
  });
};

const buildArxivRelevanceContext = ({
  document = {},
  termLimit = DEFAULT_RELEVANCE_TERM_LIMIT,
  topic = "",
} = {}) => {
  const topicTerms = splitTopicTerms(topic).filter(isSearchableTopicTerm);
  const rankedTerms = rankArxivTopicCandidatesFromDocumentProfile(document, {
    limit: termLimit,
  });
  const relevanceTerms = uniq([...topicTerms, ...rankedTerms]).slice(
    0,
    termLimit
  );

  return {
    relevanceTerms,
    topicTerms,
  };
};

const getPaperText = (paper = {}) =>
  normalizeText(
    [
      paper.title,
      paper.summary,
      ...toArray(paper.authors),
      paper.primaryCategory,
      ...toArray(paper.categories),
    ].join(" ")
  );

const buildPaperTermSet = (value) =>
  new Set(
    extractMeaningfulTokens(value)
      .map(normalizeTopicTerm)
      .filter(isSearchableTopicTerm)
  );

const includesTermPhrase = (value, terms) => {
  if (terms.length < 2) {
    return false;
  }

  const normalizedValue = ` ${normalizeTopicTerm(value)} `;
  const normalizedPhrase = ` ${terms.join(" ")} `;

  return normalizedValue.includes(normalizedPhrase);
};

export const evaluateArxivPaperRelevance = ({
  document,
  paper = {},
  topic = "",
} = {}) => {
  const relevanceContext = buildArxivRelevanceContext({
    document,
    topic,
  });
  const { relevanceTerms, topicTerms } = relevanceContext;

  if (relevanceTerms.length === 0) {
    return {
      matchedTerms: [],
      passed: false,
      reason: "no_relevance_terms",
      score: 0,
    };
  }

  const title = normalizeText(paper.title);
  const summary = normalizeText(paper.summary);
  const paperText = getPaperText(paper);
  const titleTerms = buildPaperTermSet(title);
  const summaryTerms = buildPaperTermSet(summary);
  const paperTerms = buildPaperTermSet(paperText);
  const titleMatchedTerms = relevanceTerms.filter((term) => titleTerms.has(term));
  const summaryMatchedTerms = relevanceTerms.filter((term) =>
    summaryTerms.has(term)
  );
  const matchedTerms = relevanceTerms.filter((term) => paperTerms.has(term));
  const phraseMatched =
    includesTermPhrase(title, topicTerms) ||
    includesTermPhrase(summary, topicTerms);
  const score =
    titleMatchedTerms.length * 2 +
    summaryMatchedTerms.length +
    (phraseMatched ? 3 : 0);
  const requiredMatchedTerms = Math.min(
    MIN_RELEVANCE_MATCHED_TERMS,
    relevanceTerms.length
  );
  const passed =
    matchedTerms.length >= requiredMatchedTerms && score >= MIN_RELEVANCE_SCORE;

  return {
    matchedTerms,
    passed,
    reason: passed ? null : "low_relevance",
    score,
  };
};

export const filterRelevantArxivPapers = ({ document, papers = [], topic }) =>
  papers.filter(
    (paper) =>
      evaluateArxivPaperRelevance({
        document,
        paper,
        topic,
      }).passed
  );
