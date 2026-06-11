import React, { useCallback, useState } from "react";
import { Layout, Typography, message } from "antd";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import WorkspaceSidebar from "./components/WorkspaceSidebar";
import {
  fetchLatestQualityReport,
  fetchQualityHistory,
  requestAnswerFeedback,
  requestSyntheticQualityRun,
} from "./archiveApi";
import { useChatSession } from "./hooks/useChatSession";
import { useDocumentSelection } from "./hooks/useDocumentSelection";
import { useWorkspaceDocuments } from "./hooks/useWorkspaceDocuments";
import "./App.css";

const App = () => {
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityHistory, setQualityHistory] = useState(null);
  const [qualityReport, setQualityReport] = useState(null);
  const { Content } = Layout;
  const { Text } = Typography;
  const {
    activeTurnIndex,
    addConversationTurn,
    conversation,
    currentTurn,
    isLoading,
    resetConversation,
    rotateSession,
    sessionId,
    setActiveTurnIndex,
    setIsLoading,
    userId,
  } = useChatSession();
  const {
    activeDocuments,
    clearDocuments: clearWorkspaceDocuments,
    docIds,
    docLabel,
    handleUploadSuccess,
    removeDocument: removeWorkspaceDocument,
    totalPages,
  } = useWorkspaceDocuments();
  const {
    previewStatus,
    relevantDocuments,
    resetSelection,
    selectedDocId,
    selectedSource,
    selectTurn,
    setSelectedSource,
  } = useDocumentSelection({
    activeDocuments,
    conversation,
    currentTurn,
    setActiveTurnIndex,
  });

  const resetWorkspaceSession = useCallback(async () => {
    resetConversation();
    resetSelection();
    await rotateSession();
  }, [resetConversation, resetSelection, rotateSession]);

  const handleResp = useCallback(
    (question, answer) => {
      addConversationTurn(question, answer);
      setSelectedSource(answer?.ragSources?.[0] ?? null);
    },
    [addConversationTurn, setSelectedSource]
  );

  const removeDocument = useCallback(
    (docId) =>
      removeWorkspaceDocument(docId, {
        afterSuccess: resetWorkspaceSession,
      }),
    [removeWorkspaceDocument, resetWorkspaceSession]
  );

  const clearDocuments = useCallback(
    () =>
      clearWorkspaceDocuments({
        afterSuccess: resetWorkspaceSession,
      }),
    [clearWorkspaceDocuments, resetWorkspaceSession]
  );

  const loadLatestQualityReport = useCallback(async () => {
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
  }, []);

  const loadQualityHistory = useCallback(async () => {
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
  }, []);

  const runSyntheticQualityReport = useCallback(async () => {
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
  }, []);

  const submitAnswerFeedback = useCallback(
    async (feedback) => {
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
    },
    [docIds, sessionId, userId]
  );

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
                onSelectTurn={selectTurn}
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
