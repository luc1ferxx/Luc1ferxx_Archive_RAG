import React, { useEffect, useState } from "react";
import { Layout, Typography, message } from "antd";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import WorkspaceSidebar from "./components/WorkspaceSidebar";
import {
  fetchDocuments,
  fetchLatestQualityReport,
  fetchQualityHistory,
  requestAnswerFeedback,
  requestDocumentClear,
  requestDocumentDelete,
  requestSessionClear,
  requestSyntheticQualityRun,
} from "./archiveApi";
import {
  createSessionId,
  persistSessionId,
  persistUserId,
  readStoredSessionId,
  readStoredUserId,
} from "./archiveSession";
import {
  buildRelevantDocuments,
  formatDocumentCount,
  getTotalPages,
} from "./archiveWorkspace";
import "./App.css";

const App = () => {
  const [conversation, setConversation] = useState([]);
  const [activeTurnIndex, setActiveTurnIndex] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityHistory, setQualityHistory] = useState(null);
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
      setQualityHistory(await fetchQualityHistory());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to load the latest quality report.";
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  };

  const loadQualityHistory = async () => {
    setIsQualityLoading(true);

    try {
      setQualityHistory(await fetchQualityHistory());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to load quality history.";
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  };

  const runSyntheticQualityReport = async () => {
    setIsQualityLoading(true);

    try {
      setQualityReport(await requestSyntheticQualityRun());
      setQualityHistory(await fetchQualityHistory());
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
  const submitAnswerFeedback = async (feedback) => {
    try {
      await requestAnswerFeedback({
        ...feedback,
        docIds: feedback.docIds ?? docIds,
        sessionId,
        userId,
      });
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to save feedback.";
      message.error(backendMessage);
    }
  };
  const docLabel =
    activeDocuments.length === 1
      ? activeDocuments[0].fileName
      : formatDocumentCount(activeDocuments.length);
  const totalPages = getTotalPages(activeDocuments);
  const currentTurn =
    activeTurnIndex !== null && conversation[activeTurnIndex]
      ? conversation[activeTurnIndex]
      : conversation[conversation.length - 1] ?? null;
  const currentSources = currentTurn?.answer?.ragSources ?? [];
  const selectedDocId = selectedSource?.docId ?? null;
  const relevantDocuments = buildRelevantDocuments({
    activeDocuments,
    currentSources,
  });
  const previewStatus = selectedSource
    ? `${selectedSource.fileName} · page ${selectedSource.pageNumber ?? 1}`
    : "Choose a citation or relevant document";

  return (
    <div className="archive-shell">
      <Layout className="archive-layout">
        <Content className="archive-app">
          <WorkspaceSidebar
            activeDocuments={activeDocuments}
            conversationCount={conversation.length}
            currentTurn={currentTurn}
            isQualityLoading={isQualityLoading}
            onClearDocuments={clearDocuments}
            onLoadQualityHistory={loadQualityHistory}
            onLoadQualityLatest={loadLatestQualityReport}
            onRemoveDocument={removeDocument}
            onRunSyntheticQuality={runSyntheticQualityReport}
            onSelectSource={setSelectedSource}
            onUploadSuccess={handleUploadSuccess}
            qualityHistory={qualityHistory}
            qualityReport={qualityReport}
            relevantDocuments={relevantDocuments}
            selectedDocId={selectedDocId}
            totalPages={totalPages}
          />

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
                onFeedback={(feedback) => void submitAnswerFeedback(feedback)}
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
