import { createTaskService, TASK_STATUSES } from "./tasks.js";

export const RECOMMENDATION_TASK_TYPE = "external_recommendation";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const getProviderLabel = (provider) => {
  const normalizedProvider = normalizeText(provider);

  if (normalizedProvider.toLowerCase() === "arxiv") {
    return "arXiv";
  }

  return normalizedProvider || "External";
};

const buildRecommendationTaskId = ({ docId, provider }) =>
  `${RECOMMENDATION_TASK_TYPE}:${normalizeText(provider)}:${normalizeText(docId)}`;

const buildDocumentSubject = (document = {}) => ({
  id: normalizeText(document.docId),
  kind: "document",
  label: normalizeText(document.fileName) || normalizeText(document.docId),
});

const buildProvider = (provider) => ({
  id: normalizeText(provider),
  label: getProviderLabel(provider),
});

const getPaperId = (paper = {}) => normalizeText(paper.arxivId ?? paper.id);

const buildPaperTaskItem = ({ paper = {}, result = {}, status }) => {
  const id = getPaperId(paper) || getPaperId(result);

  if (!id) {
    return null;
  }

  return {
    id,
    error: result.error ?? null,
    label: normalizeText(paper.title ?? result.title) || id,
    result: {
      docId: normalizeText(result.docId),
      fileName: normalizeText(result.fileName),
      status: normalizeText(result.status),
    },
    status,
    summary: normalizeText(result.error) || normalizeText(result.status) || status,
  };
};

const buildPaperTaskItems = ({ papers = [], status }) =>
  toArray(papers)
    .map((paper) =>
      buildPaperTaskItem({
        paper,
        status,
      })
    )
    .filter(Boolean);

const buildCompletedPaperTaskItems = ({ importResult = {}, selectedPapers = [] }) => {
  const importedById = new Map(
    toArray(importResult.importedPapers)
      .map((paper) => [getPaperId(paper), paper])
      .filter(([id]) => id)
  );
  const skippedById = new Map(
    toArray(importResult.skippedPapers)
      .map((paper) => [getPaperId(paper), paper])
      .filter(([id]) => id)
  );
  const failedById = new Map(
    toArray(importResult.failedPapers)
      .map((paper) => [getPaperId(paper), paper])
      .filter(([id]) => id)
  );

  return toArray(selectedPapers)
    .map((paper) => {
      const paperId = getPaperId(paper);

      if (failedById.has(paperId)) {
        return buildPaperTaskItem({
          paper,
          result: failedById.get(paperId),
          status: TASK_STATUSES.failed,
        });
      }

      if (skippedById.has(paperId)) {
        return buildPaperTaskItem({
          paper,
          result: skippedById.get(paperId),
          status: TASK_STATUSES.completed,
        });
      }

      if (importedById.has(paperId)) {
        return buildPaperTaskItem({
          paper,
          result: importedById.get(paperId),
          status: TASK_STATUSES.completed,
        });
      }

      return buildPaperTaskItem({
        paper,
        status: TASK_STATUSES.pending,
      });
    })
    .filter(Boolean);
};

const countImportFailures = (importResult = {}) =>
  Number(importResult.failedCount ?? toArray(importResult.failedPapers).length) || 0;

const countRemainingPapers = (remainingSuggestion = {}) =>
  toArray(remainingSuggestion?.papers).length;

const buildFailureSummary = ({ error, providerLabel }) =>
  `${providerLabel} import failed: ${normalizeText(error?.message) || "Unknown error."}`;

const mapPaperProgressStatus = (status) => {
  const normalizedStatus = normalizeText(status);

  if (["imported", "skipped"].includes(normalizedStatus)) {
    return TASK_STATUSES.completed;
  }

  if (normalizedStatus === "failed") {
    return TASK_STATUSES.failed;
  }

  return TASK_STATUSES.running;
};

export const createRecommendationTaskService = ({
  taskService = createTaskService(),
} = {}) => {
  const upsertRecommendationTask = async ({ accessScope = {}, provider, task }) =>
    taskService.upsertTask({
      accessScope,
      task: {
        provider: buildProvider(provider),
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
    const docId = normalizeText(document.docId);

    if (!docId) {
      return null;
    }

    const papers = toArray(suggestion.papers);
    const providerLabel = getProviderLabel(provider);
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
          requestedMaxResults: suggestion.requestedMaxResults ?? papers.length,
          topic: normalizeText(suggestion.topic),
        },
        items: buildPaperTaskItems({
          papers,
          status: hasImportableRecommendations
            ? TASK_STATUSES.waitingForUser
            : TASK_STATUSES.completed,
        }),
        label: `${providerLabel} recommendations`,
        requiredUserAction: hasImportableRecommendations ? "confirm_import" : "",
        result: {
          paperIds: papers.map((paper) => normalizeText(paper.arxivId ?? paper.id)),
          reason: suggestion.reason ?? null,
        },
        runnerId,
        status,
        subject: buildDocumentSubject(document),
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
    runnerId,
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const providerLabel = getProviderLabel(provider);
    const selectedCount = toArray(selectedPapers).length;

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
          topic: normalizeText(topic),
        },
        items: buildPaperTaskItems({
          papers: selectedPapers,
          status: TASK_STATUSES.queued,
        }),
        label: `${providerLabel} import`,
        payload,
        requiredUserAction: "",
        runnerId,
        status: TASK_STATUSES.queued,
        subject: buildDocumentSubject({
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
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const providerLabel = getProviderLabel(provider);
    const selectedCount = toArray(selectedPapers).length;

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
          topic: normalizeText(topic),
        },
        items: buildPaperTaskItems({
          papers: selectedPapers,
          status: TASK_STATUSES.running,
        }),
        label: `${providerLabel} import`,
        requiredUserAction: "",
        status: TASK_STATUSES.running,
        subject: buildDocumentSubject({
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
    const normalizedDocId = normalizeText(docId);
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

    const paperId = getPaperId(paper) || getPaperId(result);

    if (!paperId) {
      return task;
    }

    const nextItem = buildPaperTaskItem({
      paper,
      result: {
        ...result,
        error: error instanceof Error ? error.message : result.error,
        status,
      },
      status: mapPaperProgressStatus(status),
    });
    const existingItems = toArray(task.items);
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
    remainingSuggestion = null,
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const failedCount = countImportFailures(importResult);
    const importedCount = Number(importResult.importedCount ?? 0) || 0;
    const remainingCount = countRemainingPapers(remainingSuggestion);
    const skippedCount = Number(importResult.skippedCount ?? 0) || 0;
    const selectedCount = toArray(selectedPapers).length;
    const providerLabel = getProviderLabel(provider);
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
          topic: normalizeText(topic),
        },
        label:
          status === TASK_STATUSES.waitingForUser
            ? `${providerLabel} recommendations`
            : `${providerLabel} import`,
        requiredUserAction:
          status === TASK_STATUSES.waitingForUser ? "confirm_import" : "",
        result: {
          failedPapers: toArray(importResult.failedPapers).map((paper) => ({
            id: normalizeText(paper.arxivId ?? paper.id),
            title: normalizeText(paper.title),
            error: normalizeText(paper.error),
          })),
          importedPapers: toArray(importResult.importedPapers).map((paper) => ({
            docId: normalizeText(paper.docId),
            id: normalizeText(paper.arxivId ?? paper.id),
            title: normalizeText(paper.title),
          })),
          remainingPaperIds: toArray(remainingSuggestion?.papers).map((paper) =>
            normalizeText(paper.arxivId ?? paper.id)
          ),
          skippedPapers: toArray(importResult.skippedPapers).map((paper) => ({
            docId: normalizeText(paper.docId),
            id: normalizeText(paper.arxivId ?? paper.id),
            title: normalizeText(paper.title),
          })),
        },
        items: buildCompletedPaperTaskItems({
          importResult,
          selectedPapers,
        }),
        status,
        subject: buildDocumentSubject({
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
    selectedPapers = [],
    topic = "",
  } = {}) => {
    const normalizedDocId = normalizeText(docId ?? document.docId);

    if (!normalizedDocId) {
      return null;
    }

    const providerLabel = getProviderLabel(provider);

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
          failed: toArray(selectedPapers).length,
          selected: toArray(selectedPapers).length,
        },
        error: normalizeText(error?.message) || "Unknown error.",
        input: {
          topic: normalizeText(topic),
        },
        label: `${providerLabel} import`,
        items: buildPaperTaskItems({
          papers: selectedPapers,
          status: TASK_STATUSES.failed,
        }),
        requiredUserAction: "",
        status: TASK_STATUSES.failed,
        subject: buildDocumentSubject({
          ...document,
          docId: normalizedDocId,
        }),
        summary: buildFailureSummary({
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
