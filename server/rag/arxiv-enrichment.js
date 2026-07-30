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
import { createRecommendationTaskService } from "./recommendation-tasks.js";
import { TASK_STATUSES } from "./tasks.js";

export {
  ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
  buildArxivTopicFromDocumentProfile,
  evaluateArxivPaperRelevance,
  rankArxivTopicCandidatesFromDocumentProfile,
};

const toArray = (value) => (Array.isArray(value) ? value : []);
const TASK_CLAIM_LOST = "TASK_CLAIM_LOST";

const isCooperativeAbortError = (error, signal) =>
  signal?.aborted ||
  error?.code === TASK_CLAIM_LOST ||
  error?.name === "AbortError";

const assertImportActive = ({ assertClaimActive, signal } = {}) => {
  assertClaimActive?.();

  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error("arXiv import was aborted.");

  error.name = "AbortError";
  throw error;
};

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
  const recommendationTaskBuilder = createRecommendationTaskService({
    taskService: {
      upsertTask: async ({ task }) => task,
    },
  });
  const recordRecommendationTask = async (
    methodName,
    payload,
    {
      recorder = recommendationTaskService,
      strict = false,
    } = {}
  ) => {
    try {
      return (await recorder?.[methodName]?.(payload)) ?? null;
    } catch (error) {
      if (strict) {
        throw error;
      }

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
    assertClaimActive,
    docId,
    document,
    onPaperProgress,
    queryPolicy,
    relevantSelectedPapers = [],
    signal,
    taskRecorder = recommendationTaskService,
    taskWritesStrict = false,
    topic,
  } = {}) => {
    assertImportActive({
      assertClaimActive,
      signal,
    });
    await recordRecommendationTask(
      "recordImportStarted",
      {
        accessScope,
        docId,
        document: buildArxivDocumentSummary(document),
        provider: ARXIV_RECOMMENDATION_PROVIDER,
        queryPolicy,
        selectedPapers: relevantSelectedPapers,
        topic,
      },
      {
        recorder: taskRecorder,
        strict: taskWritesStrict,
      }
    );
    assertImportActive({
      assertClaimActive,
      signal,
    });

    let importResult;

    try {
      importResult = await arxivImportService.importPapers({
        accessScope,
        assertClaimActive,
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
        signal,
        topic,
      });
    } catch (error) {
      if (isCooperativeAbortError(error, signal)) {
        assertImportActive({
          assertClaimActive,
          signal,
        });
        throw error;
      }

      error.task = await recordRecommendationTask(
        "recordImportFailed",
        {
          accessScope,
          docId,
          document: buildArxivDocumentSummary(document),
          error,
          provider: ARXIV_RECOMMENDATION_PROVIDER,
          queryPolicy,
          selectedPapers: relevantSelectedPapers,
          topic,
        },
        {
          recorder: taskRecorder,
          strict: taskWritesStrict,
        }
      );
      throw error;
    }

    assertImportActive({
      assertClaimActive,
      signal,
    });
    const remainingSuggestion = recommendationSnapshotService.updateAfterImport({
      accessScope,
      docId,
      importResult,
      selectedPapers: relevantSelectedPapers,
      topic,
    });

    assertImportActive({
      assertClaimActive,
      signal,
    });
    const task = await recordRecommendationTask(
      "recordImportCompleted",
      {
        accessScope,
        docId,
        document: buildArxivDocumentSummary(document),
        importResult,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
        queryPolicy,
        remainingSuggestion,
        selectedPapers: relevantSelectedPapers,
        topic,
      },
      {
        recorder: taskRecorder,
        strict: taskWritesStrict,
      }
    );
    assertImportActive({
      assertClaimActive,
      signal,
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
      assertClaimActive: options.assertClaimActive,
      signal: options.signal,
    });

    return result;
  };

  const runImportTask = async ({
    accessScope = {},
    assertClaimActive,
    patchTask,
    signal,
    task,
    taskWriter,
  } = {}) => {
    const payload = task?.payload ?? {};
    const docId = payload.docId ?? task?.subject?.id;
    const document = {
      docId,
      fileName: task?.subject?.label,
    };
    const queryPolicy = payload.queryPolicy ?? task?.input?.queryPolicy ?? null;
    const selectedPapers = toArray(payload.selectedPapers);
    const topic = payload.topic ?? task?.input?.topic ?? "";
    const jobTaskWriter = taskWriter
      ? {
          getTask: taskWriter.getTask,
          patchTask: taskWriter.patchTask,
          upsertTask: ({ task: nextTask = {} } = {}) =>
            nextTask.status === TASK_STATUSES.running
              ? taskWriter.upsertTask({
                  task: nextTask,
                })
              : nextTask,
        }
      : null;
    const taskRecorder = taskWriter
      ? createRecommendationTaskService({
          taskService: jobTaskWriter,
        })
      : recommendationTaskService;

    try {
      const result = await executePreparedImport({
        accessScope,
        assertClaimActive,
        docId,
        document,
        onPaperProgress: async (event) => {
          await recordRecommendationTask(
            "recordImportProgress",
            {
              accessScope,
              docId,
              error: event.error,
              paper: event.paper,
              provider: ARXIV_RECOMMENDATION_PROVIDER,
              result: event.result,
              status: event.status,
            },
            {
              recorder: taskRecorder,
              strict: Boolean(taskWriter),
            }
          );
        },
        queryPolicy,
        relevantSelectedPapers: selectedPapers,
        signal,
        taskRecorder,
        taskWritesStrict: Boolean(taskWriter),
        topic,
      });

      return {
        ...(result.task ?? {}),
        payload: null,
      };
    } catch (error) {
      if (isCooperativeAbortError(error, signal)) {
        assertImportActive({
          assertClaimActive,
          signal,
        });
        throw error;
      }

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
    deferTaskPersistence = false,
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
    const queuedTask = await recordRecommendationTask(
      "recordImportQueued",
      {
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
      },
      {
        recorder: deferTaskPersistence
          ? recommendationTaskBuilder
          : recommendationTaskService,
        strict: true,
      }
    );

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
