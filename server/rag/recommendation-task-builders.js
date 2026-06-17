import { serializeExternalQueryPolicy } from "./external-query-policy.js";
import { buildSafeExternalDocumentSummary } from "./external-context-sanitizer.js";
import { TASK_STATUSES } from "./tasks.js";

export const RECOMMENDATION_TASK_TYPE = "external_recommendation";

export const normalizeRecommendationTaskText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

export const toRecommendationTaskArray = (value) =>
  Array.isArray(value) ? value : [];

export const getRecommendationProviderLabel = (provider) => {
  const normalizedProvider = normalizeRecommendationTaskText(provider);

  if (normalizedProvider.toLowerCase() === "arxiv") {
    return "arXiv";
  }

  return normalizedProvider || "External";
};

export const buildRecommendationTaskId = ({ docId, provider }) =>
  `${RECOMMENDATION_TASK_TYPE}:${normalizeRecommendationTaskText(
    provider
  )}:${normalizeRecommendationTaskText(docId)}`;

export const buildRecommendationDocumentSubject = (document = {}) => {
  const summary = buildSafeExternalDocumentSummary({
    document,
  });
  const docId = normalizeRecommendationTaskText(summary.docId);

  return {
    id: docId,
    kind: "document",
    label: normalizeRecommendationTaskText(summary.fileName) || docId,
  };
};

export const buildRecommendationProvider = (provider) => ({
  id: normalizeRecommendationTaskText(provider),
  label: getRecommendationProviderLabel(provider),
});

export const buildRecommendationExternalQueryInput = ({
  queryPolicy,
  topic,
}) => ({
  queryPolicy: serializeExternalQueryPolicy(queryPolicy),
  topic: normalizeRecommendationTaskText(topic),
});

export const getRecommendationPaperId = (paper = {}) =>
  normalizeRecommendationTaskText(paper.arxivId ?? paper.id);

export const buildRecommendationPaperTaskItem = ({
  paper = {},
  result = {},
  status,
}) => {
  const id = getRecommendationPaperId(paper) || getRecommendationPaperId(result);

  if (!id) {
    return null;
  }

  return {
    id,
    error: result.error ?? null,
    label: normalizeRecommendationTaskText(paper.title ?? result.title) || id,
    result: {
      docId: normalizeRecommendationTaskText(result.docId),
      fileName: normalizeRecommendationTaskText(result.fileName),
      status: normalizeRecommendationTaskText(result.status),
    },
    status,
    summary:
      normalizeRecommendationTaskText(result.error) ||
      normalizeRecommendationTaskText(result.status) ||
      status,
  };
};

export const buildRecommendationPaperTaskItems = ({ papers = [], status }) =>
  toRecommendationTaskArray(papers)
    .map((paper) =>
      buildRecommendationPaperTaskItem({
        paper,
        status,
      })
    )
    .filter(Boolean);

export const buildCompletedRecommendationPaperTaskItems = ({
  importResult = {},
  selectedPapers = [],
}) => {
  const importedById = new Map(
    toRecommendationTaskArray(importResult.importedPapers)
      .map((paper) => [getRecommendationPaperId(paper), paper])
      .filter(([id]) => id)
  );
  const skippedById = new Map(
    toRecommendationTaskArray(importResult.skippedPapers)
      .map((paper) => [getRecommendationPaperId(paper), paper])
      .filter(([id]) => id)
  );
  const failedById = new Map(
    toRecommendationTaskArray(importResult.failedPapers)
      .map((paper) => [getRecommendationPaperId(paper), paper])
      .filter(([id]) => id)
  );

  return toRecommendationTaskArray(selectedPapers)
    .map((paper) => {
      const paperId = getRecommendationPaperId(paper);

      if (failedById.has(paperId)) {
        return buildRecommendationPaperTaskItem({
          paper,
          result: failedById.get(paperId),
          status: TASK_STATUSES.failed,
        });
      }

      if (skippedById.has(paperId)) {
        return buildRecommendationPaperTaskItem({
          paper,
          result: skippedById.get(paperId),
          status: TASK_STATUSES.completed,
        });
      }

      if (importedById.has(paperId)) {
        return buildRecommendationPaperTaskItem({
          paper,
          result: importedById.get(paperId),
          status: TASK_STATUSES.completed,
        });
      }

      return buildRecommendationPaperTaskItem({
        paper,
        status: TASK_STATUSES.pending,
      });
    })
    .filter(Boolean);
};

export const countRecommendationImportFailures = (importResult = {}) =>
  Number(
    importResult.failedCount ??
      toRecommendationTaskArray(importResult.failedPapers).length
  ) || 0;

export const countRemainingRecommendationPapers = (remainingSuggestion = {}) =>
  toRecommendationTaskArray(remainingSuggestion?.papers).length;

export const buildRecommendationFailureSummary = ({ error, providerLabel }) =>
  `${providerLabel} import failed: ${
    normalizeRecommendationTaskText(error?.message) || "Unknown error."
  }`;

export const mapRecommendationPaperProgressStatus = (status) => {
  const normalizedStatus = normalizeRecommendationTaskText(status);

  if (["imported", "skipped"].includes(normalizedStatus)) {
    return TASK_STATUSES.completed;
  }

  if (normalizedStatus === "failed") {
    return TASK_STATUSES.failed;
  }

  return TASK_STATUSES.running;
};
