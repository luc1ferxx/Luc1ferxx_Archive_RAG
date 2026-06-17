import { createTaskService, TASK_STATUSES } from "./tasks.js";
import {
  buildCompletedRecommendationPaperTaskItems,
  buildRecommendationDocumentSubject,
  buildRecommendationExternalQueryInput,
  buildRecommendationFailureSummary,
  buildRecommendationPaperTaskItem,
  buildRecommendationPaperTaskItems,
  buildRecommendationProvider,
  buildRecommendationTaskId,
  countRecommendationImportFailures,
  countRemainingRecommendationPapers,
  getRecommendationPaperId,
  getRecommendationProviderLabel,
  mapRecommendationPaperProgressStatus,
  normalizeRecommendationTaskText,
  RECOMMENDATION_TASK_TYPE,
  toRecommendationTaskArray,
} from "./recommendation-task-builders.js";

export { RECOMMENDATION_TASK_TYPE };

export const createRecommendationTaskService = ({
  taskService = createTaskService(),
} = {}) => {
  const upsertRecommendationTask = async ({ accessScope = {}, provider, task }) =>
    taskService.upsertTask({
      accessScope,
      task: {
        provider: buildRecommendationProvider(provider),
        type: RECOMMENDATION_TASK_TYPE,
        ...task,
      },
    });

  const recordSuggestionResult = async ({
    accessScope = {},
    provider,
    runnerId = "",
    suggestion = {},
  } = {}) => {
    const document = suggestion.document ?? {};
    const docId = normalizeRecommendationTaskText(document.docId);

    if (!docId) {
      return null;
    }

    const papers = toRecommendationTaskArray(suggestion.papers);
    const providerLabel = getRecommendationProviderLabel(provider);
    const hasImportableRecommendations =
      papers.length > 0 && Boolean(suggestion.selectionToken);
    const status = hasImportableRecommendations
      ? TASK_STATUSES.waitingForUser
      : TASK_STATUSES.completed;

    return upsertRecommendationTask({
      accessScope,
      provider,
      task: {
        id: buildRecommendationTaskId({
          docId,
          provider,
        }),
        action: hasImportableRecommendations
          ? "review_recommendations"
          : "recommendation_check",
        counts: {
          failed: 0,
          imported: 0,
          recommended: papers.length,
          remaining: papers.length,
          selected: 0,
          skipped: 0,
        },
        input: {
          ...buildRecommendationExternalQueryInput({
            queryPolicy: suggestion.queryPolicy,
            topic: suggestion.topic,
          }),
          requestedMaxResults: suggestion.requestedMaxResults ?? papers.length,
        },
        items: buildRecommendationPaperTaskItems({
          papers,
          status: hasImportableRecommendations
            ? TASK_STATUSES.waitingForUser
            : TASK_STATUSES.completed,
        }),
        label: `${providerLabel} recommendations`,
        requiredUserAction: hasImportableRecommendations ? "confirm_import" : "",
        result: {
          paperIds: papers.map((paper) => normalizeRecommendationTaskText(paper.arxivId ?? paper.id)),
          reason: suggestion.reason ?? null,
        },
        runnerId,
        status,
        subject: buildRecommendationDocumentSubject(document),
        summary: hasImportableRecommendations
          ? `Found ${papers.length} ${providerLabel} recommendations for review.`
          : `No importable ${providerLabel} recommendations were found.`,
      },
    });
  };

  const recordImportQueued = async ({
    accessScope = {},
    docId,
    document = {},
    payload = null,
    provider,
    queryPolicy,
    runnerId,
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeRecommendationTaskText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const providerLabel = getRecommendationProviderLabel(provider);
    const selectedCount = toRecommendationTaskArray(selectedPapers).length;

    return upsertRecommendationTask({
      accessScope,
      provider,
      task: {
        id: buildRecommendationTaskId({
          docId: normalizedDocId,
          provider,
        }),
        action: "import_recommendations",
        counts: {
          failed: 0,
          imported: 0,
          remaining: 0,
          selected: selectedCount,
          skipped: 0,
        },
        input: {
          ...buildRecommendationExternalQueryInput({
            queryPolicy,
            topic,
          }),
        },
        items: buildRecommendationPaperTaskItems({
          papers: selectedPapers,
          status: TASK_STATUSES.queued,
        }),
        label: `${providerLabel} import`,
        payload,
        requiredUserAction: "",
        runnerId,
        status: TASK_STATUSES.queued,
        subject: buildRecommendationDocumentSubject({
          ...document,
          docId: normalizedDocId,
        }),
        summary: `Queued ${selectedCount} selected ${providerLabel} recommendations for import.`,
      },
    });
  };

  const recordImportStarted = async ({
    accessScope = {},
    docId,
    document = {},
    provider,
    queryPolicy,
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeRecommendationTaskText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const providerLabel = getRecommendationProviderLabel(provider);
    const selectedCount = toRecommendationTaskArray(selectedPapers).length;

    return upsertRecommendationTask({
      accessScope,
      provider,
      task: {
        id: buildRecommendationTaskId({
          docId: normalizedDocId,
          provider,
        }),
        action: "import_recommendations",
        counts: {
          selected: selectedCount,
        },
        input: {
          ...buildRecommendationExternalQueryInput({
            queryPolicy,
            topic,
          }),
        },
        items: buildRecommendationPaperTaskItems({
          papers: selectedPapers,
          status: TASK_STATUSES.running,
        }),
        label: `${providerLabel} import`,
        requiredUserAction: "",
        status: TASK_STATUSES.running,
        subject: buildRecommendationDocumentSubject({
          ...document,
          docId: normalizedDocId,
        }),
        summary: `Importing ${selectedCount} selected ${providerLabel} recommendations.`,
      },
    });
  };

  const recordImportProgress = async ({
    accessScope = {},
    docId,
    error,
    paper = {},
    provider,
    result = {},
    status,
  } = {}) => {
    const normalizedDocId = normalizeRecommendationTaskText(docId);
    const taskId = buildRecommendationTaskId({
      docId: normalizedDocId,
      provider,
    });
    const task = await taskService.getTask({
      accessScope,
      taskId,
    });

    if (!task) {
      return null;
    }

    const paperId = getRecommendationPaperId(paper) || getRecommendationPaperId(result);

    if (!paperId) {
      return task;
    }

    const nextItem = buildRecommendationPaperTaskItem({
      paper,
      result: {
        ...result,
        error: error instanceof Error ? error.message : result.error,
        status,
      },
      status: mapRecommendationPaperProgressStatus(status),
    });
    const existingItems = toRecommendationTaskArray(task.items);
    const hasItem = existingItems.some((item) => item.id === paperId);
    const items = hasItem
      ? existingItems.map((item) => (item.id === paperId ? nextItem : item))
      : [...existingItems, nextItem];

    return taskService.patchTask({
      accessScope,
      taskId,
      patch: {
        items,
      },
    });
  };

  const recordImportCompleted = async ({
    accessScope = {},
    docId,
    document = {},
    importResult = {},
    provider,
    queryPolicy,
    remainingSuggestion = null,
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeRecommendationTaskText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const failedCount = countRecommendationImportFailures(importResult);
    const importedCount = Number(importResult.importedCount ?? 0) || 0;
    const remainingCount = countRemainingRecommendationPapers(remainingSuggestion);
    const skippedCount = Number(importResult.skippedCount ?? 0) || 0;
    const selectedCount = toRecommendationTaskArray(selectedPapers).length;
    const providerLabel = getRecommendationProviderLabel(provider);
    const status =
      failedCount > 0
        ? TASK_STATUSES.failed
        : remainingCount > 0
          ? TASK_STATUSES.waitingForUser
          : TASK_STATUSES.completed;

    return upsertRecommendationTask({
      accessScope,
      provider,
      task: {
        id: buildRecommendationTaskId({
          docId: normalizedDocId,
          provider,
        }),
        action:
          status === TASK_STATUSES.waitingForUser
            ? "review_remaining_recommendations"
            : "import_recommendations",
        counts: {
          failed: failedCount,
          imported: importedCount,
          recommended: selectedCount + remainingCount,
          remaining: remainingCount,
          selected: selectedCount,
          skipped: skippedCount,
        },
        input: {
          ...buildRecommendationExternalQueryInput({
            queryPolicy,
            topic,
          }),
        },
        label:
          status === TASK_STATUSES.waitingForUser
            ? `${providerLabel} recommendations`
            : `${providerLabel} import`,
        requiredUserAction:
          status === TASK_STATUSES.waitingForUser ? "confirm_import" : "",
        result: {
          failedPapers: toRecommendationTaskArray(importResult.failedPapers).map((paper) => ({
            id: normalizeRecommendationTaskText(paper.arxivId ?? paper.id),
            title: normalizeRecommendationTaskText(paper.title),
            error: normalizeRecommendationTaskText(paper.error),
          })),
          importedPapers: toRecommendationTaskArray(importResult.importedPapers).map((paper) => ({
            docId: normalizeRecommendationTaskText(paper.docId),
            id: normalizeRecommendationTaskText(paper.arxivId ?? paper.id),
            title: normalizeRecommendationTaskText(paper.title),
          })),
          remainingPaperIds: toRecommendationTaskArray(remainingSuggestion?.papers).map((paper) =>
            normalizeRecommendationTaskText(paper.arxivId ?? paper.id)
          ),
          skippedPapers: toRecommendationTaskArray(importResult.skippedPapers).map((paper) => ({
            docId: normalizeRecommendationTaskText(paper.docId),
            id: normalizeRecommendationTaskText(paper.arxivId ?? paper.id),
            title: normalizeRecommendationTaskText(paper.title),
          })),
        },
        items: buildCompletedRecommendationPaperTaskItems({
          importResult,
          selectedPapers,
        }),
        status,
        subject: buildRecommendationDocumentSubject({
          ...document,
          docId: normalizedDocId,
        }),
        summary:
          remainingCount > 0 && failedCount === 0
            ? `Imported ${importedCount}, skipped ${skippedCount}; ${remainingCount} ${providerLabel} recommendations remain.`
            : `Imported ${importedCount}, skipped ${skippedCount}, failed ${failedCount} ${providerLabel} papers.`,
      },
    });
  };

  const recordImportFailed = async ({
    accessScope = {},
    docId,
    document = {},
    error,
    provider,
    queryPolicy,
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeRecommendationTaskText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const providerLabel = getRecommendationProviderLabel(provider);

    return upsertRecommendationTask({
      accessScope,
      provider,
      task: {
        id: buildRecommendationTaskId({
          docId: normalizedDocId,
          provider,
        }),
        action: "import_recommendations",
        counts: {
          failed: toRecommendationTaskArray(selectedPapers).length,
          selected: toRecommendationTaskArray(selectedPapers).length,
        },
        error: normalizeRecommendationTaskText(error?.message) || "Unknown error.",
        input: {
          ...buildRecommendationExternalQueryInput({
            queryPolicy,
            topic,
          }),
        },
        label: `${providerLabel} import`,
        items: buildRecommendationPaperTaskItems({
          papers: selectedPapers,
          status: TASK_STATUSES.failed,
        }),
        requiredUserAction: "",
        status: TASK_STATUSES.failed,
        subject: buildRecommendationDocumentSubject({
          ...document,
          docId: normalizedDocId,
        }),
        summary: buildRecommendationFailureSummary({
          error,
          providerLabel,
        }),
      },
    });
  };

  return {
    recordImportCompleted,
    recordImportFailed,
    recordImportProgress,
    recordImportQueued,
    recordImportStarted,
    recordSuggestionResult,
  };
};
