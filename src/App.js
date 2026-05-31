import React, { useEffect, useState } from "react";
import axios from "axios";
import { ExperimentOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Layout, Typography, message } from "antd";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import { API_DOMAIN, buildApiRequestConfig } from "./config";
import "./App.css";

const SESSION_STORAGE_KEY = "archive-session-id";
const USER_STORAGE_KEY = "archive-user-id";

const createStableId = (prefix) =>
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : null) ??
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createSessionId = () => createStableId("session");

const createUserId = () => createStableId("user");

const readStoredId = (storageKey, fallbackFactory) => {
  try {
    const storedValue = window.localStorage.getItem(storageKey);
    return storedValue?.trim() ? storedValue : fallbackFactory();
  } catch {
    return fallbackFactory();
  }
};

const readStoredSessionId = () => readStoredId(SESSION_STORAGE_KEY, createSessionId);

const readStoredUserId = () => readStoredId(USER_STORAGE_KEY, createUserId);

const persistStoredId = (storageKey, value) => {
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // Ignore localStorage failures for browsers with restricted storage access.
  }
};

const persistSessionId = (sessionId) => persistStoredId(SESSION_STORAGE_KEY, sessionId);

const persistUserId = (userId) => persistStoredId(USER_STORAGE_KEY, userId);

const fetchDocuments = async () => {
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.get(`${API_DOMAIN}/documents`, requestConfig)
    : await axios.get(`${API_DOMAIN}/documents`);
  return response.data;
};

const requestDocumentDelete = async (docId) => {
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.delete(`${API_DOMAIN}/documents/${docId}`, requestConfig)
    : await axios.delete(`${API_DOMAIN}/documents/${docId}`);
  return response.data;
};

const requestDocumentClear = async () => {
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.post(`${API_DOMAIN}/documents/clear`, undefined, requestConfig)
    : await axios.post(`${API_DOMAIN}/documents/clear`);
  return response.data;
};

const requestSessionClear = async (sessionId) => {
  if (!sessionId) {
    return;
  }

  const requestConfig = buildApiRequestConfig();

  if (requestConfig) {
    await axios.delete(`${API_DOMAIN}/sessions/${sessionId}`, requestConfig);
    return;
  }

  await axios.delete(`${API_DOMAIN}/sessions/${sessionId}`);
};

const fetchLatestQualityReport = async () => {
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.get(`${API_DOMAIN}/quality/latest`, requestConfig)
    : await axios.get(`${API_DOMAIN}/quality/latest`);
  return response.data;
};

const requestSyntheticQualityRun = async () => {
  const payload = {
    corpusPath: "evaluation/synthetic-corpus-near-duplicate.json",
  };
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.post(`${API_DOMAIN}/quality/synthetic`, payload, requestConfig)
    : await axios.post(`${API_DOMAIN}/quality/synthetic`, payload);
  return response.data;
};

const formatPageCount = (pageCount) => {
  const parsed = Number.parseInt(pageCount ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : "?";
};

const formatDocumentCount = (count) =>
  count === 1 ? "1 document" : `${count} documents`;

const getDocumentTags = (document) =>
  document?.tags ?? document?.profile?.tags ?? [];

const getDocumentSummary = (document) =>
  document?.summary ?? document?.profile?.summary ?? "";

const formatQualityPercent = (value) =>
  typeof value === "number" ? `${value.toFixed(value % 1 === 0 ? 0 : 1)}%` : "N/A";

const formatQualityNumber = (value) =>
  typeof value === "number" ? value.toFixed(value % 1 === 0 ? 0 : 1) : "N/A";

const DocumentProfileSnippet = ({ document, compact = false }) => {
  const tags = getDocumentTags(document).slice(0, compact ? 3 : 5);
  const summary = getDocumentSummary(document);

  if (tags.length === 0 && !summary) {
    return null;
  }

  return (
    <div className={`document-profile ${compact ? "is-compact" : ""}`}>
      {tags.length > 0 ? (
        <div className="document-tag-list">
          {tags.map((tag) => (
            <span key={tag} className="document-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {summary ? <div className="document-summary">{summary}</div> : null}
    </div>
  );
};

const QualityGuardPanel = ({
  isQualityLoading,
  onLoadLatest,
  onRunSynthetic,
  qualityReport,
}) => {
  const metrics = qualityReport?.summary?.metrics ?? {};
  const failedCases = qualityReport?.failedCases ?? [];
  const recommendations = qualityReport?.recommendations ?? [];
  const status = qualityReport?.status ?? "idle";
  const statusLabel =
    {
      ok: "OK",
      warn: "Warn",
      fail: "Fail",
      idle: "Idle",
    }[status] ?? status;

  return (
    <div className="quality-panel">
      <div className="quality-actions">
        <Button
          className="archive-secondary-button quality-action-button"
          icon={<ReloadOutlined />}
          loading={isQualityLoading}
          onClick={() => void onLoadLatest()}
        >
          Latest
        </Button>
        <Button
          className="archive-secondary-button quality-action-button"
          icon={<ExperimentOutlined />}
          loading={isQualityLoading}
          onClick={() => void onRunSynthetic()}
        >
          Run eval
        </Button>
      </div>

      {qualityReport ? (
        <>
          <div className={`quality-status quality-status-${status}`}>
            <span>{statusLabel}</span>
            <span>{qualityReport.summary?.runId ?? "latest run"}</span>
          </div>

          <div className="quality-metrics">
            <div className="quality-metric">
              <span>Pass</span>
              <strong>{formatQualityPercent(metrics.overallPassPercent)}</strong>
            </div>
            <div className="quality-metric">
              <span>Page hit</span>
              <strong>{formatQualityPercent(metrics.qaPageHitPercent)}</strong>
            </div>
            <div className="quality-metric">
              <span>Citations</span>
              <strong>{formatQualityNumber(metrics.averageCitationCount)}</strong>
            </div>
          </div>

          {failedCases.length > 0 ? (
            <div className="quality-failure-list">
              {failedCases.slice(0, 3).map((caseResult) => (
                <div key={caseResult.id} className="quality-failure-item">
                  <span>{caseResult.id}</span>
                  <p>{caseResult.reasons?.join(", ") ?? "Case failed"}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="quality-empty-note">No failed cases in the latest run.</div>
          )}

          <div className="quality-recommendation-list">
            {recommendations.slice(0, 2).map((recommendation) => (
              <div key={recommendation.label} className="quality-recommendation-item">
                {recommendation.label}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="archive-empty-state archive-empty-state-compact">
          <div className="archive-empty-mark">No quality report loaded</div>
          <div>Load the latest report or run the default synthetic corpus.</div>
        </div>
      )}
    </div>
  );
};

const App = () => {
  const [conversation, setConversation] = useState([]);
  const [activeTurnIndex, setActiveTurnIndex] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityReport, setQualityReport] = useState(null);
  const [activeDocuments, setActiveDocuments] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [sessionId, setSessionId] = useState(() => readStoredSessionId());
  const [userId] = useState(() => readStoredUserId());
  const { Content } = Layout;
  const { Text } = Typography;

  useEffect(() => {
    persistSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    persistUserId(userId);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;

    const loadDocuments = async () => {
      try {
        const documents = await fetchDocuments();

        if (!cancelled) {
          setActiveDocuments(documents);
        }
      } catch (error) {
        if (!cancelled) {
          const backendMessage =
            error.response?.data?.error ?? "Unable to load persisted documents.";
          message.error(backendMessage);
        }
      }
    };

    void loadDocuments();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (conversation.length === 0) {
      setActiveTurnIndex(null);
      return;
    }

    if (activeTurnIndex === null || activeTurnIndex >= conversation.length) {
      setActiveTurnIndex(conversation.length - 1);
    }
  }, [activeTurnIndex, conversation]);

  const resetConversationState = () => {
    setConversation([]);
    setSelectedSource(null);
    setActiveTurnIndex(null);
  };

  const rotateSession = async () => {
    const previousSessionId = sessionId;
    const nextSessionId = createSessionId();

    try {
      await requestSessionClear(previousSessionId);
    } catch (error) {
      console.error("Failed to clear persisted session memory:", error);
    }

    setSessionId(nextSessionId);
    persistSessionId(nextSessionId);
  };

  const buildPreviewSourceFromDocument = (document, citation = null) => ({
    docId: document.docId,
    fileName: document.fileName,
    filePath: citation?.filePath || document.publicFilePath || "",
    pageNumber: citation?.pageNumber ?? 1,
    excerpt: citation?.excerpt ?? "",
    chunkIndex: citation?.chunkIndex ?? null,
  });

  const handleResp = (question, answer) => {
    const nextTurnIndex = conversation.length;

    setConversation((prev) => [...prev, { question, answer }]);
    setActiveTurnIndex(nextTurnIndex);
    setSelectedSource(answer?.ragSources?.[0] ?? null);
  };

  const handleUploadSuccess = (document) => {
    setActiveDocuments((prev) => {
      if (prev.some((existingDocument) => existingDocument.docId === document.docId)) {
        return prev;
      }

      return [...prev, document];
    });
  };

  const removeDocument = async (docId) => {
    try {
      await requestDocumentDelete(docId);
      setActiveDocuments((prev) =>
        prev.filter((document) => document.docId !== docId)
      );
      resetConversationState();
      await rotateSession();
      message.success("Document removed.");
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to remove the document.";
      message.error(backendMessage);
    }
  };

  const clearDocuments = async () => {
    try {
      await requestDocumentClear();
      setActiveDocuments([]);
      resetConversationState();
      await rotateSession();
      message.success("All documents cleared.");
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to clear documents.";
      message.error(backendMessage);
    }
  };

  const loadLatestQualityReport = async () => {
    setIsQualityLoading(true);

    try {
      setQualityReport(await fetchLatestQualityReport());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to load the latest quality report.";
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  };

  const runSyntheticQualityReport = async () => {
    setIsQualityLoading(true);

    try {
      setQualityReport(await requestSyntheticQualityRun());
      message.success("Synthetic evaluation complete.");
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to run the synthetic evaluation.";
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  };

  const handleSelectTurn = (turnIndex) => {
    setActiveTurnIndex(turnIndex);

    const selectedTurn = conversation[turnIndex];

    if (!selectedTurn) {
      return;
    }

    const turnSources = selectedTurn.answer?.ragSources ?? [];
    const selectionBelongsToTurn = turnSources.some(
      (source) =>
        source.docId === selectedSource?.docId &&
        source.chunkIndex === selectedSource?.chunkIndex
    );

    if (!selectionBelongsToTurn) {
      setSelectedSource(turnSources[0] ?? null);
    }
  };

  const docIds = activeDocuments.map((document) => document.docId);
  const docLabel =
    activeDocuments.length === 1
      ? activeDocuments[0].fileName
      : formatDocumentCount(activeDocuments.length);
  const totalPages = activeDocuments.reduce(
    (sum, document) => sum + (Number.parseInt(document.pageCount ?? "0", 10) || 0),
    0
  );
  const currentTurn =
    activeTurnIndex !== null && conversation[activeTurnIndex]
      ? conversation[activeTurnIndex]
      : conversation[conversation.length - 1] ?? null;
  const currentSources = currentTurn?.answer?.ragSources ?? [];
  const selectedDocId = selectedSource?.docId ?? null;

  const relevantDocuments = [...new Map(
    currentSources.map((source) => {
      const matchingDocument = activeDocuments.find(
        (document) => document.docId === source.docId
      );
      const existingEntry = {
        docId: source.docId,
        fileName: source.fileName,
        pageCount: matchingDocument?.pageCount ?? null,
        summary: getDocumentSummary(matchingDocument),
        tags: getDocumentTags(matchingDocument),
        profile: matchingDocument?.profile ?? null,
        pages: [],
        previewSource: buildPreviewSourceFromDocument(
          matchingDocument ?? {
            docId: source.docId,
            fileName: source.fileName,
            publicFilePath: source.filePath,
          },
          source
        ),
      };

      return [source.docId, existingEntry];
    })
  ).values()].map((entry) => ({
    ...entry,
    pages: [
      ...new Set(
        currentSources
          .filter((source) => source.docId === entry.docId)
          .map((source) => source.pageNumber)
          .filter(Boolean)
      ),
    ].sort((left, right) => left - right),
  }));

  const previewStatus = selectedSource
    ? `${selectedSource.fileName} · page ${selectedSource.pageNumber ?? 1}`
    : "Choose a citation or relevant document";

  return (
    <div className="archive-shell">
      <Layout className="archive-layout">
        <Content className="archive-app">
          <aside className="archive-sidebar">
            <div className="archive-sidebar-top">
              <div className="archive-sidebar-title-row">
                <div className="archive-sidebar-title-group">
                  <div className="archive-sidebar-kicker">Workspace</div>
                  <div className="archive-sidebar-title">Document Compare</div>
                </div>

                <div className="archive-sidebar-count">{activeDocuments.length}</div>
              </div>

              <div className="archive-sidebar-summary">
                <span className="archive-sidebar-summary-chip">
                  {formatDocumentCount(activeDocuments.length)}
                </span>
                <span className="archive-sidebar-summary-chip">
                  {totalPages} pages indexed
                </span>
              </div>
            </div>

            <section className="archive-sidebar-section archive-upload-section">
              <div className="archive-sidebar-section-head">
                <span className="archive-sidebar-section-title">Upload</span>
                <span className="archive-sidebar-section-caption">
                  Add PDFs to the workspace
                </span>
              </div>
              <PdfUploader onUploadSuccess={handleUploadSuccess} />
            </section>

            <section className="archive-sidebar-section archive-context-section">
              <div className="archive-sidebar-section-head">
                <span className="archive-sidebar-section-title">
                  Relevant documents
                </span>
                <span className="archive-sidebar-section-caption">
                  {currentTurn
                    ? "Files referenced in the active answer"
                    : "Ask a question to surface related files"}
                </span>
              </div>

              {relevantDocuments.length > 0 ? (
                <div className="relevant-document-list">
                  {relevantDocuments.map((document) => (
                    <button
                      key={document.docId}
                      type="button"
                      className={`relevant-document-item ${
                        selectedDocId === document.docId ? "is-selected" : ""
                      }`}
                      aria-pressed={selectedDocId === document.docId}
                      onClick={() => setSelectedSource(document.previewSource)}
                    >
                      <div className="relevant-document-title">{document.fileName}</div>
                      <div className="relevant-document-meta">
                        {document.pages.length > 0
                          ? `Pages ${document.pages.join(", ")}`
                          : "Page 1"}
                      </div>
                      <DocumentProfileSnippet document={document} compact />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="archive-empty-state archive-empty-state-compact">
                  <div className="archive-empty-mark">No relevant documents yet</div>
                  <div>The current answer has not cited any pages yet.</div>
                </div>
              )}
            </section>

            <section className="archive-sidebar-section archive-doc-section">
              <div className="archive-sidebar-section-head">
                <span className="archive-sidebar-section-title">
                  Workspace documents
                </span>
                <span className="archive-sidebar-section-caption">
                  {formatDocumentCount(activeDocuments.length)}
                </span>
              </div>

              {activeDocuments.length > 0 ? (
                <div className="document-list">
                  {activeDocuments.map((document) => (
                    <article
                      key={document.docId}
                      className={`document-item ${
                        selectedDocId === document.docId ? "is-selected" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className={`document-item-main document-item-main-button ${
                          selectedDocId === document.docId ? "is-selected" : ""
                        }`}
                        aria-pressed={selectedDocId === document.docId}
                        onClick={() =>
                          setSelectedSource(buildPreviewSourceFromDocument(document))
                        }
                      >
                        <div className="document-item-title">{document.fileName}</div>
                        <div className="document-item-meta">
                          {formatPageCount(document.pageCount)} pages · ID{" "}
                          {document.docId.slice(0, 8)}
                        </div>
                        <DocumentProfileSnippet document={document} />
                      </button>

                      <button
                        type="button"
                        className="document-item-remove"
                        aria-label={`Remove ${document.fileName}`}
                        onClick={() => void removeDocument(document.docId)}
                      >
                        ×
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="archive-empty-state">
                  <div className="archive-empty-mark">No documents yet</div>
                  <div>Upload at least one PDF to start asking questions.</div>
                </div>
              )}
            </section>

            <section className="archive-sidebar-section archive-quality-section">
              <div className="archive-sidebar-section-head">
                <span className="archive-sidebar-section-title">Quality Guard</span>
                <span className="archive-sidebar-section-caption">
                  Synthetic RAG checks and failure hints
                </span>
              </div>
              <QualityGuardPanel
                isQualityLoading={isQualityLoading}
                onLoadLatest={loadLatestQualityReport}
                onRunSynthetic={runSyntheticQualityReport}
                qualityReport={qualityReport}
              />
            </section>

            <section className="archive-sidebar-footer">
              <div className="archive-sidebar-stats">
                <div className="archive-sidebar-stat">
                  <span className="archive-meta-label">Responses</span>
                  <span className="archive-meta-value">{conversation.length}</span>
                </div>
                <div className="archive-sidebar-stat">
                  <span className="archive-meta-label">Pages</span>
                  <span className="archive-meta-value">{totalPages}</span>
                </div>
              </div>

              <Button
                className="archive-secondary-button archive-sidebar-clear"
                onClick={() => void clearDocuments()}
                disabled={activeDocuments.length === 0}
              >
                Clear workspace
              </Button>
            </section>
          </aside>

          <section className="archive-preview-column">
            <div className="archive-main-header archive-preview-header">
              <div className="section-label">
                <span className="section-label-title">Preview</span>
                <span className="section-label-caption">{previewStatus}</span>
              </div>
            </div>

            <div className="archive-card archive-preview-card">
              <PdfPreview source={selectedSource} />
            </div>
          </section>

          <section className="archive-main">
            <div className="archive-main-header">
              <div className="section-label">
                <span className="section-label-title">Conversation</span>
                <span className="section-label-caption">
                  {activeDocuments.length > 0
                    ? `Working with ${docLabel}`
                    : "Agent workspace is empty"}
                </span>
              </div>
              <Text className="archive-meta-text">
                {conversation.length} recorded turns
              </Text>
            </div>

            <div className="archive-card archive-conversation-card">
              <RenderQA
                conversation={conversation}
                activeTurnIndex={activeTurnIndex}
                isLoading={isLoading}
                selectedSource={selectedSource}
                onSelectSource={setSelectedSource}
                onSelectTurn={handleSelectTurn}
              />
            </div>

            <div className="archive-composer">
              <ChatComponent
                docIds={docIds}
                docLabel={docLabel}
                sessionId={sessionId}
                userId={userId}
                handleResp={handleResp}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
              />
            </div>
          </section>
        </Content>
      </Layout>
    </div>
  );
};

export default App;
