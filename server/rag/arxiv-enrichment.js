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

  // A search's result: the document's task, then its snapshot. The search
  // read the task (`searchedTask`) before it called arXiv, which can take
  // seconds, so what it publishes is checked now. The task store refuses the
  // task once it is no longer the one read (an import confirmed meanwhile,
  // queued, running or already ended, is never overwritten), and nothing is
  // published for a document the caller's scope no longer has.
  const publishSuggestion = async ({ accessScope, docId, searchedTask, suggestion }) => {
    getScopedDocument({ accessScope, docId, ragService });

    let task;

    try {
      task = await recommendationTaskService?.recordSuggestionResult?.({
        accessScope,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
        runnerId: ARXIV_RECOMMENDATION_IMPORT_RUNNER_ID,
        searchedTask,
        suggestion,
      });
    } catch {
      // A failing task store does not fail the search: it answers without
      // its task, as it always has.
      task = undefined;
    }

    if (task === null) {
      const error = new Error(
        "This document's arXiv recommendations changed during the search: an import was confirmed or another search finished first."
      );
      error.status = 409;
      throw error;
    }

    // A delete that landed while the task was written ran its cascade before
    // the write, so the task goes here. One after this check finds the task
    // in its own cascade, and the snapshot below is saved in this same tick.
    try {
      getScopedDocument({ accessScope, docId, ragService });
    } catch (error) {
      await recordRecommendationTask("deleteDocumentTasks", {
        accessScope,
        docIds: [docId],
        provider: ARXIV_RECOMMENDATION_PROVIDER,
      });
      throw error;
    }

    return {
      ...recommendationSnapshotService.save({
        accessScope,
        suggestion,
      }),
      task: task ?? null,
    };
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
    // A search rewrites the document's one recommendation task, which would
    // stop an import still queued or running on it.
    const currentTask = await recommendationTaskService?.getDocumentTask?.({
      accessScope,
      docId,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
    });

    if (
      currentTask?.status === TASK_STATUSES.queued ||
      currentTask?.status === TASK_STATUSES.running
    ) {
      const error = new Error("An arXiv import for this document is still running.");
      error.status = 409;
      throw error;
    }

    if (!isExternalQueryPolicyAllowed(queryPolicy)) {
      return publishSuggestion({
        accessScope,
        docId,
        searchedTask: currentTask,
        suggestion: buildBlockedArxivSuggestion({
          document,
          queryPolicy,
          requestedMaxResults,
          topic,
        }),
      });
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

    return publishSuggestion({
      accessScope,
      docId,
      searchedTask: currentTask,
      suggestion: buildArxivRecommendationSuggestion({
        docId,
        document,
        papers,
        queryPolicy,
        requestedMaxResults,
        searchedPaperCount: searchedPapers.length,
        selectionTokenService,
        topic,
      }),
    });
  };

  const prepareImportForDocument = ({
    accessScope = {},
    docId,
    issuedSelectionToken,
    selectedArxivIds,
    selectionToken,
  } = {}) => {
    return prepareArxivImportForDocument({
      accessScope,
      docId,
      issuedSelectionToken,
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

  // A direct import (POST /documents/:docId/arxiv/import, the
  // recommendation.import_selected Capability) confirms the saved suggestion,
  // which this process holds.
  const importForDocument = async (options = {}) => {
    const preparedImport = prepareImportForDocument({
      ...options,
      issuedSelectionToken: recommendationSnapshotService.getSelectionToken({
        accessScope: options.accessScope,
        docId: options.docId,
      }),
    });

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

      // The task's end state carries the offer of the papers left, if any
      // (recordImportCompleted), in place of this job's payload.
      return {
        payload: null,
        ...(result.task ?? {}),
      };
    } catch (error) {
      if (isCooperativeAbortError(error, signal)) {
        assertImportActive({
          assertClaimActive,
          signal,
        });
        throw error;
      }

      // A failed import can be confirmed again from the offer it came from.
      const offer = payload.selectionToken ? { selectionToken: payload.selectionToken } : null;

      await patchTask?.({
        payload: offer,
      });

      return error.task ?? {
        error: error instanceof Error ? error.message : String(error),
        payload: offer,
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

    // `task` is the stored task (the job orchestrator reads it with its
    // internal payload), which holds the offer this confirms: the token is
    // checked against it on whichever tier runs this.
    const issuedSelectionToken = task.payload?.selectionToken;
    const preparedImport = prepareImportForDocument({
      accessScope,
      docId: payload.docId ?? task.subject?.id,
      issuedSelectionToken,
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
          selectionToken: issuedSelectionToken,
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
