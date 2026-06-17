import { buildSafeExternalDocumentSummary } from "./external-context-sanitizer.js";

export const ARXIV_RECOMMENDATION_PROVIDER = "arxiv";
export const ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID =
  "arxiv_recommendation_import";

const toArray = (value) => (Array.isArray(value) ? value : []);

export const buildArxivDocumentSummary = (document = {}) =>
  buildSafeExternalDocumentSummary({
    document,
  });

export const buildBlockedArxivSuggestion = ({
  document,
  queryPolicy,
  requestedMaxResults,
  topic,
} = {}) => ({
  document: buildArxivDocumentSummary(document),
  queryPolicy,
  topic,
  requestedMaxResults,
  papers: [],
  reason: "external_query_blocked",
  trace: {
    externalQueryPolicy: queryPolicy,
  },
});

export const buildArxivRecommendationSuggestion = ({
  docId,
  document,
  papers = [],
  queryPolicy,
  requestedMaxResults,
  searchedPaperCount = 0,
  selectionTokenService,
  topic,
} = {}) => {
  const safePapers = toArray(papers);

  return {
    document: buildArxivDocumentSummary(document),
    queryPolicy,
    topic,
    requestedMaxResults,
    papers: safePapers,
    selectionToken:
      safePapers.length > 0
        ? selectionTokenService.createSelectionToken({
            docId,
            papers: safePapers,
            requestedMaxResults,
            topic,
          })
        : null,
    reason:
      safePapers.length === 0
        ? searchedPaperCount === 0
          ? "no_arxiv_matches"
          : "no_relevant_arxiv_matches"
        : null,
    trace: {
      externalQueryPolicy: queryPolicy,
    },
  };
};
