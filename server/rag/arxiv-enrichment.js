import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "./arxiv-client.js";
import {
  buildArxivQueryPolicyFromDocumentProfile,
  buildArxivTopicFromDocumentProfile,
  evaluateArxivPaperRelevance,
  filterRelevantArxivPapers,
  rankArxivTopicCandidatesFromDocumentProfile,
} from "./arxiv-query-policy.js";
import { prepareArxivImportForDocument } from "./arxiv-import-selection.js";
import { createArxivRecommendationSnapshotService } from "./arxiv-recommendation-snapshots.js";
import { createArxivSelectionTokenService } from "./arxiv-selection-token.js";
import {
  isExternalQueryPolicyAllowed,
  serializeExternalQueryPolicy,
} from "./external-query-policy.js";
import {
  ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
  ARXIV_RECOMMENDATION_PROVIDER,
  buildArxivDocumentSummary,
  buildArxivRecommendationSuggestion,
  buildBlockedArxivSuggestion,
} from "./arxiv-recommendation-builder.js";

export {
  ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
  buildArxivTopicFromDocumentProfile,
  evaluateArxivPaperRelevance,
  rankArxivTopicCandidatesFromDocumentProfile,
};

const toArray = (value) => (Array.isArray(value) ? value : []);

const getScopedDocument = ({ accessScope, docId, ragService }) => {
  const document = ragService.getDocument?.(docId, accessScope) ?? null;

  if (!document) {
    const error = new Error("Document not found.");
    error.status = 404;
    throw error;
  }

  return document;
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
        suggestion: buildBlockedArxivSuggestion({
          document,
          queryPolicy,
          requestedMaxResults,
          topic,
        }),
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

    const suggestion = buildArxivRecommendationSuggestion({
      docId,
      document,
      papers,
      queryPolicy,
      requestedMaxResults,
      searchedPaperCount: searchedPapers.length,
      selectionTokenService,
      topic,
    });

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
    return prepareArxivImportForDocument({
      accessScope,
      docId,
      resolveTopicForDocument,
      selectedArxivIds,
      selectionToken,
      selectionTokenService,
    });
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
      document: buildArxivDocumentSummary(document),
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
        document: buildArxivDocumentSummary(document),
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
      document: buildArxivDocumentSummary(document),
      importResult,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
      queryPolicy,
      remainingSuggestion,
      selectedPapers: relevantSelectedPapers,
      topic,
    });

    return {
      document: buildArxivDocumentSummary(document),
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
      document: buildArxivDocumentSummary(preparedImport.document),
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
