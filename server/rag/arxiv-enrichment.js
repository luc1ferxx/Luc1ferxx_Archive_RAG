import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "./arxiv-client.js";
import { createArxivRecommendationSnapshotService } from "./arxiv-recommendation-snapshots.js";
import { createArxivSelectionTokenService } from "./arxiv-selection-token.js";
import {
  buildExternalQueryPolicy,
  buildExternalQuerySensitiveTerms,
  EXTERNAL_QUERY_STOP_TERMS,
  getExternalQueryInternalIdentifiers,
  isExternalQueryPolicyAllowed,
  isSearchableExternalQueryTerm,
  normalizeExternalQueryTerm,
  serializeExternalQueryPolicy,
  splitExternalQueryTerms,
} from "./external-query-policy.js";
import { extractMeaningfulTokens } from "./text-utils.js";

const ARXIV_RECOMMENDATION_PROVIDER = "arxiv";
export const ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID =
  "arxiv_recommendation_import";

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

const filterRelevantArxivPapers = ({ document, papers = [], topic }) =>
  papers.filter(
    (paper) =>
      evaluateArxivPaperRelevance({
        document,
        paper,
        topic,
      }).passed
  );

const getScopedDocument = ({ accessScope, docId, ragService }) => {
  const document = ragService.getDocument?.(docId, accessScope) ?? null;

  if (!document) {
    const error = new Error("Document not found.");
    error.status = 404;
    throw error;
  }

  return document;
};

const buildDocumentSummary = (document = {}) => ({
  docId: document.docId,
  fileName: document.fileName,
});

const assertSelectionError = (message) => {
  const error = new Error(message);
  error.status = 400;
  throw error;
};

const normalizeSelectedArxivIds = (selectedArxivIds) => {
  if (selectedArxivIds === undefined || selectedArxivIds === null) {
    return null;
  }

  if (!Array.isArray(selectedArxivIds)) {
    assertSelectionError("selectedArxivIds must be an array.");
  }

  const ids = [
    ...new Set(selectedArxivIds.map(normalizeText).filter(Boolean)),
  ];

  if (ids.length === 0) {
    assertSelectionError("Select at least one arXiv paper to import.");
  }

  return ids;
};

const getSelectedPapers = ({ papers = [], selectedArxivIds }) => {
  const normalizedIds = normalizeSelectedArxivIds(selectedArxivIds);

  if (!normalizedIds) {
    return papers;
  }

  const papersById = new Map(
    papers
      .map((paper) => [normalizeText(paper.arxivId), paper])
      .filter(([arxivId]) => arxivId)
  );
  const missingIds = normalizedIds.filter((arxivId) => !papersById.has(arxivId));

  if (missingIds.length > 0) {
    assertSelectionError("Selected arXiv papers are not in this recommendation set.");
  }

  return normalizedIds.map((arxivId) => papersById.get(arxivId));
};

export const createArxivEnrichmentService = ({
  arxivImportService,
  arxivService,
  now = () => new Date().toISOString(),
  ragService,
  recommendationTaskService,
  recommendationSnapshotStore,
  selectionTokenService = createArxivSelectionTokenService(),
} = {}) => {
  const resolveTopicForDocument = ({ accessScope = {}, docId }) => {
    const document = getScopedDocument({
      accessScope,
      docId,
      ragService,
    });
    const queryPolicy = serializeExternalQueryPolicy(
      buildArxivQueryPolicyFromDocumentProfile(document, {
        accessScope,
      })
    );
    const topic = queryPolicy.sanitizedQuery;

    return {
      document,
      queryPolicy,
      topic,
    };
  };

  const recommendationSnapshotService = createArxivRecommendationSnapshotService({
    now,
    recommendationSnapshotStore,
    resolveDocumentTopic: resolveTopicForDocument,
    selectionTokenService,
  });
  const recordRecommendationTask = async (methodName, payload) => {
    try {
      return (await recommendationTaskService?.[methodName]?.(payload)) ?? null;
    } catch {
      return null;
    }
  };

  const suggestForDocument = async ({
    accessScope = {},
    docId,
    maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  } = {}) => {
    const { document, queryPolicy, topic } = resolveTopicForDocument({
      accessScope,
      docId,
    });
    const requestedMaxResults = normalizeArxivMaxResults(maxResults);

    if (!isExternalQueryPolicyAllowed(queryPolicy)) {
      const savedSuggestion = recommendationSnapshotService.save({
        accessScope,
        suggestion: {
          document: buildDocumentSummary(document),
          queryPolicy,
          topic,
          requestedMaxResults,
          papers: [],
          reason: "external_query_blocked",
          trace: {
            externalQueryPolicy: queryPolicy,
          },
        },
      });

      const task = await recordRecommendationTask("recordSuggestionResult", {
        accessScope,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
        runnerId: ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
        suggestion: savedSuggestion,
      });

      return {
        ...savedSuggestion,
        task,
      };
    }

    const searchedPapers = await arxivService.search({
      topic,
      maxResults: requestedMaxResults,
    });
    const papers = filterRelevantArxivPapers({
      document,
      papers: searchedPapers,
      topic,
    });

    const suggestion = {
      document: buildDocumentSummary(document),
      queryPolicy,
      topic,
      requestedMaxResults,
      papers,
      selectionToken:
        papers.length > 0
          ? selectionTokenService.createSelectionToken({
              docId,
              papers,
              requestedMaxResults,
              topic,
            })
          : null,
      reason:
        papers.length === 0
          ? searchedPapers.length === 0
            ? "no_arxiv_matches"
            : "no_relevant_arxiv_matches"
          : null,
      trace: {
        externalQueryPolicy: queryPolicy,
      },
    };

    const savedSuggestion = recommendationSnapshotService.save({
      accessScope,
      suggestion,
    });

    const task = await recordRecommendationTask("recordSuggestionResult", {
      accessScope,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
      runnerId: ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
      suggestion: savedSuggestion,
    });

    return {
      ...savedSuggestion,
      task,
    };
  };

  const prepareImportForDocument = ({
    accessScope = {},
    docId,
    selectedArxivIds,
    selectionToken,
  } = {}) => {
    const { document, queryPolicy, topic } = resolveTopicForDocument({
      accessScope,
      docId,
    });

    if (!isExternalQueryPolicyAllowed(queryPolicy)) {
      const error = new Error(
        "No arXiv topic could be derived from this document profile."
      );
      error.status = 422;
      throw error;
    }

    if (!selectionToken) {
      const error = new Error("selectionToken is required.");
      error.status = 400;
      throw error;
    }

    const selection = selectionTokenService.verifySelectionToken(selectionToken);

    if (selection.docId !== docId) {
      const error = new Error("arXiv selection token does not match this document.");
      error.status = 400;
      throw error;
    }

    if (selection.topic !== topic) {
      const error = new Error(
        "arXiv selection token no longer matches this document profile."
      );
      error.status = 409;
      throw error;
    }

    const selectedPapers = getSelectedPapers({
      papers: selection.papers,
      selectedArxivIds,
    });
    const relevantSelectedPapers = filterRelevantArxivPapers({
      document,
      papers: selectedPapers,
      topic,
    });

    if (relevantSelectedPapers.length !== selectedPapers.length) {
      const error = new Error(
        "Selected arXiv papers no longer pass relevance checks."
      );
      error.status = 409;
      throw error;
    }

    return {
      docId,
      document,
      queryPolicy,
      relevantSelectedPapers,
      topic,
    };
  };

  const executePreparedImport = async ({
    accessScope = {},
    docId,
    document,
    onPaperProgress,
    queryPolicy,
    relevantSelectedPapers = [],
    topic,
  } = {}) => {
    await recordRecommendationTask("recordImportStarted", {
      accessScope,
      docId,
      document: buildDocumentSummary(document),
      provider: ARXIV_RECOMMENDATION_PROVIDER,
      queryPolicy,
      selectedPapers: relevantSelectedPapers,
      topic,
    });

    let importResult;

    try {
      importResult = await arxivImportService.importPapers({
        accessScope,
        importContext: {
          importedByUserConfirmation: true,
          relatedToDocId: docId,
        },
        maxResults: normalizeArxivMaxResults(
          relevantSelectedPapers.length,
          relevantSelectedPapers.length || DEFAULT_ARXIV_MAX_RESULTS
        ),
        onPaperProgress,
        papers: relevantSelectedPapers,
        topic,
      });
    } catch (error) {
      error.task = await recordRecommendationTask("recordImportFailed", {
        accessScope,
        docId,
        document: buildDocumentSummary(document),
        error,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
        queryPolicy,
        selectedPapers: relevantSelectedPapers,
        topic,
      });
      throw error;
    }

    const remainingSuggestion = recommendationSnapshotService.updateAfterImport({
      accessScope,
      docId,
      importResult,
      selectedPapers: relevantSelectedPapers,
      topic,
    });

    const task = await recordRecommendationTask("recordImportCompleted", {
      accessScope,
      docId,
      document: buildDocumentSummary(document),
      importResult,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
      queryPolicy,
      remainingSuggestion,
      selectedPapers: relevantSelectedPapers,
      topic,
    });

    return {
      document: buildDocumentSummary(document),
      task,
      ...importResult,
    };
  };

  const importForDocument = async (options = {}) => {
    const preparedImport = prepareImportForDocument(options);

    const { task, ...result } = await executePreparedImport({
      ...preparedImport,
      accessScope: options.accessScope,
    });

    return result;
  };

  const runImportTask = async ({ accessScope = {}, patchTask, task } = {}) => {
    const payload = task?.payload ?? {};
    const docId = payload.docId ?? task?.subject?.id;
    const document = {
      docId,
      fileName: task?.subject?.label,
    };
    const queryPolicy = payload.queryPolicy ?? task?.input?.queryPolicy ?? null;
    const selectedPapers = toArray(payload.selectedPapers);
    const topic = payload.topic ?? task?.input?.topic ?? "";

    try {
      const result = await executePreparedImport({
        accessScope,
        docId,
        document,
        onPaperProgress: async (event) => {
          await recordRecommendationTask("recordImportProgress", {
            accessScope,
            docId,
            error: event.error,
            paper: event.paper,
            provider: ARXIV_RECOMMENDATION_PROVIDER,
            result: event.result,
            status: event.status,
          });
        },
        queryPolicy,
        relevantSelectedPapers: selectedPapers,
        topic,
      });

      return {
        ...(result.task ?? {}),
        payload: null,
      };
    } catch (error) {
      await patchTask?.({
        payload: null,
      });

      return error.task ?? {
        error: error instanceof Error ? error.message : String(error),
        payload: null,
        status: "failed",
      };
    }
  };

  const resumeImportTask = async ({
    accessScope = {},
    action,
    payload = {},
    task = {},
  } = {}) => {
    if (action !== "confirm") {
      const error = new Error("Unsupported task action.");
      error.status = 400;
      throw error;
    }

    const preparedImport = prepareImportForDocument({
      accessScope,
      docId: payload.docId ?? task.subject?.id,
      selectedArxivIds: payload.selectedArxivIds,
      selectionToken: payload.selectionToken,
    });
    const queuedTask = await recordRecommendationTask("recordImportQueued", {
      accessScope,
      docId: preparedImport.docId,
      document: buildDocumentSummary(preparedImport.document),
      payload: {
        docId: preparedImport.docId,
        queryPolicy: preparedImport.queryPolicy,
        selectedPapers: preparedImport.relevantSelectedPapers,
        topic: preparedImport.topic,
      },
      provider: ARXIV_RECOMMENDATION_PROVIDER,
      queryPolicy: preparedImport.queryPolicy,
      runnerId: ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
      selectedPapers: preparedImport.relevantSelectedPapers,
      topic: preparedImport.topic,
    });

    return queuedTask;
  };

  return {
    getSavedSuggestionForDocument: recommendationSnapshotService.getForDocument,
    importForDocument,
    importJobRunner: {
      id: ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
      resume: resumeImportTask,
      run: runImportTask,
    },
    listSavedSuggestions: recommendationSnapshotService.list,
    resolveTopicForDocument,
    suggestForDocument,
  };
};
