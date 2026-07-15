import { apiDelete, apiDownload, apiGet, apiPost } from "./apiClient";

export const fetchDocuments = async () => {
  return apiGet("/documents");
};

export const requestDocumentDelete = async (docId) => {
  return apiDelete(`/documents/${docId}`);
};

export const requestDocumentClear = async () => {
  return apiPost("/documents/clear");
};

export const fetchWorkspaceArtifacts = async ({
  artifactType,
  limit,
  offset,
  status = "active",
} = {}) => {
  const params = new URLSearchParams();

  if (artifactType) {
    params.set("artifactType", artifactType);
  }
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  if (offset !== undefined) {
    params.set("offset", String(offset));
  }
  if (status) {
    params.set("status", status);
  }

  const query = params.toString();

  return apiGet(`/artifacts${query ? `?${query}` : ""}`);
};

export const fetchWorkspaceArtifact = async (artifactId) =>
  apiGet(`/artifacts/${encodeURIComponent(artifactId)}`);

export const downloadWorkspaceArtifact = async (artifactId) =>
  apiDownload(`/artifacts/${encodeURIComponent(artifactId)}/download`);

export const requestWorkspaceArtifactArchive = async (artifactId) =>
  apiPost(`/artifacts/${encodeURIComponent(artifactId)}/archive`, {});

export const fetchTasks = async (type) => {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";

  return apiGet(`/tasks${query}`);
};

export const fetchTask = async (taskId) => {
  return apiGet(`/tasks/${encodeURIComponent(taskId)}`);
};

export const requestTaskAction = async (taskId, action, payload = {}) => {
  return apiPost(
    `/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(action)}`,
    payload
  );
};

export const requestAgentRunAction = async (runId, action, payload = {}) => {
  return apiPost(
    `/agent-runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(
      action
    )}`,
    payload
  );
};

export const requestAgentRunStepRetry = async (runId, stepId) => {
  return apiPost(
    `/agent-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(
      stepId
    )}/actions/retry`,
    {}
  );
};

export const fetchAgentRunRecoveryRuns = async () => {
  return apiGet("/agent-runs/recovery");
};

export const requestAgentRunRecoveryAction = async (
  runId,
  action,
  payload = {}
) => {
  return apiPost(
    `/agent-runs/${encodeURIComponent(
      runId
    )}/recovery/actions/${encodeURIComponent(action)}`,
    payload
  );
};

export const fetchDocumentArxivSuggestions = async (docId, maxResults = 3) => {
  return apiGet(
    `/documents/${docId}/arxiv/suggestions?maxResults=${encodeURIComponent(
      maxResults
    )}`
  );
};

export const fetchSavedArxivSuggestions = async () => {
  return apiGet("/documents/arxiv/suggestions");
};

export const fetchSavedDocumentArxivSuggestion = async (docId) => {
  return apiGet(`/documents/${docId}/arxiv/suggestions/saved`);
};

export const requestDocumentArxivImport = async (
  docId,
  selectionToken,
  selectedArxivIds
) => {
  const payload = {
    selectionToken,
  };

  if (Array.isArray(selectedArxivIds)) {
    payload.selectedArxivIds = selectedArxivIds;
  }

  return apiPost(`/documents/${docId}/arxiv/import`, payload);
};

export const requestSessionClear = async (sessionId) => {
  if (!sessionId) {
    return;
  }

  await apiDelete(`/sessions/${sessionId}`);
};

export const fetchLatestQualityReport = async () => {
  return apiGet("/quality/latest");
};

export const fetchQualityHistory = async () => {
  return apiGet("/quality/history");
};

export const requestSyntheticQualityRun = async () => {
  const payload = {
    corpusPath: "evaluation/synthetic-corpus-near-duplicate.json",
  };

  return apiPost("/quality/synthetic", payload);
};

export const requestAnswerFeedback = async (payload) => {
  return apiPost("/feedback", payload);
};

export const requestChat = async ({ docIds, question, sessionId, userId }) => {
  const payload = {
    question,
    docIds: docIds.join(","),
    sessionId,
    userId,
  };

  return apiPost("/chat", payload);
};
