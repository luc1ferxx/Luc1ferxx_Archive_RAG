import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout, Typography, message } from "antd";
import {
  BellOutlined,
  BranchesOutlined,
  DownOutlined,
  FileSearchOutlined,
  LockOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
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
import { formatDocumentCount, isArxivDocument } from "./archiveWorkspace";
import { useChatSession } from "./hooks/useChatSession";
import { useArxivEnrichment } from "./hooks/useArxivEnrichment";
import { useDocumentSelection } from "./hooks/useDocumentSelection";
import { useTaskLog } from "./hooks/useTaskLog";
import { useWorkspaceDocuments } from "./hooks/useWorkspaceDocuments";
import {
  DEMO_CONVERSATION,
  DEMO_DOCUMENTS,
  DEMO_PREVIEW_SOURCE,
  DEMO_QUALITY_HISTORY,
  DEMO_QUALITY_REPORT,
  DEMO_RELEVANT_DOCUMENTS,
} from "./demoWorkbench";
import "./App.css";

const CONVERSATION_VIEWS = [
  { id: "chat", label: "Chat" },
  { id: "trace", label: "Trace" },
  { id: "sources", label: "Sources" },
  { id: "tasks", label: "Tasks" },
];

const CHAT_SCOPE_MODES = {
  uploaded: "uploaded",
  all: "all",
  selected: "selected",
};

const IDLE_TASKS = [
  {
    id: "idle-task",
    label: "Awaiting question",
    status: "pending",
    summary: "Ask a document question to create an agent task trace.",
  },
];

const formatTaskStatus = (status) => String(status ?? "pending").replace(/_/g, " ");

const App = () => {
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityHistory, setQualityHistory] = useState(null);
  const [qualityReport, setQualityReport] = useState(null);
  const [activeSidebarTarget, setActiveSidebarTarget] = useState("workspaces");
  const [activeConversationView, setActiveConversationView] = useState("chat");
  const [chatScopeMode, setChatScopeMode] = useState(CHAT_SCOPE_MODES.uploaded);
  const [selectedChatDocIds, setSelectedChatDocIds] = useState([]);
  const mainRef = useRef(null);
  const composerRef = useRef(null);
  const uploadRef = useRef(null);
  const documentListRef = useRef(null);
  const qualityRef = useRef(null);
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
    handleUploadSuccess,
    refreshDocuments,
    removeDocument: removeWorkspaceDocument,
    totalPages,
  } = useWorkspaceDocuments();
  const {
    clearTasks,
    isTaskLogLoading,
    loadTasks,
    tasks: taskLog,
  } = useTaskLog();
  const refreshTaskLog = useCallback(
    () =>
      loadTasks({
        silent: true,
      }),
    [loadTasks]
  );
  const {
    clearSuggestion: clearArxivSuggestion,
    clearSavedSuggestions: clearSavedArxivSuggestions,
    importSuggestion: importArxivSuggestion,
    isImporting: isArxivImporting,
    isSuggestionLoading: isArxivSuggestionLoading,
    loadSavedSuggestions: loadSavedArxivSuggestions,
    openSavedSuggestion: openSavedArxivSuggestionForDocument,
    requestSuggestions: requestArxivSuggestions,
    savedSuggestionsByDocId: savedArxivSuggestionsByDocId,
    suggestion: arxivSuggestion,
  } = useArxivEnrichment({
    onImportComplete: refreshDocuments,
    onTaskChange: refreshTaskLog,
  });
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
  const hasOnlyDemoConversation =
    conversation.length === 0 ||
    conversation.every((turn) => turn.answer?.demoWorkbench);
  const isDemoWorkbench =
    activeDocuments.length === 0 && hasOnlyDemoConversation && !isLoading;

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
        afterSuccess: async () => {
          if (arxivSuggestion?.document?.docId === docId) {
            clearArxivSuggestion();
          }

          await refreshTaskLog();
          await resetWorkspaceSession();
        },
      }),
    [
      arxivSuggestion?.document?.docId,
      clearArxivSuggestion,
      removeWorkspaceDocument,
      refreshTaskLog,
      resetWorkspaceSession,
    ]
  );

  const clearDocuments = useCallback(
    () =>
      clearWorkspaceDocuments({
        afterSuccess: async () => {
          clearArxivSuggestion();
          clearSavedArxivSuggestions();
          clearTasks();
          await resetWorkspaceSession();
        },
      }),
    [
      clearArxivSuggestion,
      clearSavedArxivSuggestions,
      clearWorkspaceDocuments,
      clearTasks,
      resetWorkspaceSession,
    ]
  );

  const handleWorkspaceUploadSuccess = useCallback(
    (document) => {
      handleUploadSuccess(document);
      void requestArxivSuggestions(document);
    },
    [handleUploadSuccess, requestArxivSuggestions]
  );

  const uploadedDocuments = useMemo(
    () => activeDocuments.filter((document) => !isArxivDocument(document)),
    [activeDocuments]
  );
  const selectedChatDocuments = useMemo(
    () =>
      activeDocuments.filter((document) =>
        selectedChatDocIds.includes(document.docId)
      ),
    [activeDocuments, selectedChatDocIds]
  );
  const chatScopeDocuments = useMemo(() => {
    if (chatScopeMode === CHAT_SCOPE_MODES.all) {
      return activeDocuments;
    }

    if (chatScopeMode === CHAT_SCOPE_MODES.selected) {
      return selectedChatDocuments;
    }

    return uploadedDocuments;
  }, [activeDocuments, chatScopeMode, selectedChatDocuments, uploadedDocuments]);
  const chatDocIds = useMemo(
    () => chatScopeDocuments.map((document) => document.docId),
    [chatScopeDocuments]
  );
  const activeDocumentIdsKey = useMemo(
    () => activeDocuments.map((document) => document.docId).join("\n"),
    [activeDocuments]
  );
  const chatDocLabel = useMemo(
    () =>
      chatScopeDocuments.length > 0
        ? formatDocumentCount(chatScopeDocuments.length)
        : "no documents in scope",
    [chatScopeDocuments.length]
  );
  const chatScopeOptions = useMemo(
    () => [
      {
        count: uploadedDocuments.length,
        id: CHAT_SCOPE_MODES.uploaded,
        label: "Uploaded",
      },
      {
        count: activeDocuments.length,
        id: CHAT_SCOPE_MODES.all,
        label: "All",
      },
      {
        count: selectedChatDocuments.length,
        id: CHAT_SCOPE_MODES.selected,
        label: "Selected",
      },
    ],
    [activeDocuments.length, selectedChatDocuments.length, uploadedDocuments.length]
  );
  const toggleChatScopeDocument = useCallback((docId) => {
    setSelectedChatDocIds((currentDocIds) =>
      currentDocIds.includes(docId)
        ? currentDocIds.filter((currentDocId) => currentDocId !== docId)
        : [...currentDocIds, docId]
    );
  }, []);

  useEffect(() => {
    const activeDocIdSet = new Set(activeDocuments.map((document) => document.docId));

    setSelectedChatDocIds((currentDocIds) =>
      currentDocIds.filter((docId) => activeDocIdSet.has(docId))
    );
  }, [activeDocuments]);

  useEffect(() => {
    if (activeDocuments.length === 0) {
      return;
    }

    if (
      chatScopeMode === CHAT_SCOPE_MODES.uploaded &&
      uploadedDocuments.length === 0
    ) {
      setChatScopeMode(CHAT_SCOPE_MODES.all);
      return;
    }

    if (
      chatScopeMode === CHAT_SCOPE_MODES.selected &&
      selectedChatDocuments.length === 0
    ) {
      setChatScopeMode(
        uploadedDocuments.length > 0 ? CHAT_SCOPE_MODES.uploaded : CHAT_SCOPE_MODES.all
      );
    }
  }, [
    activeDocuments.length,
    chatScopeMode,
    selectedChatDocuments.length,
    uploadedDocuments.length,
  ]);

  useEffect(() => {
    if (!activeDocumentIdsKey) {
      clearSavedArxivSuggestions();
      clearTasks();
      return;
    }

    void loadSavedArxivSuggestions({
      merge: true,
    });
    void refreshTaskLog();
  }, [
    activeDocumentIdsKey,
    clearSavedArxivSuggestions,
    clearTasks,
    loadSavedArxivSuggestions,
    refreshTaskLog,
  ]);

  const loadLatestQualityReport = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityReport(DEMO_QUALITY_REPORT);
      setQualityHistory(DEMO_QUALITY_HISTORY);
      message.success("Demo quality report loaded.");
      return;
    }

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
  }, [isDemoWorkbench]);

  const loadQualityHistory = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityHistory(DEMO_QUALITY_HISTORY);
      message.success("Demo quality history loaded.");
      return;
    }

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
  }, [isDemoWorkbench]);

  const runSyntheticQualityReport = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityReport(DEMO_QUALITY_REPORT);
      setQualityHistory(DEMO_QUALITY_HISTORY);
      message.success("Demo synthetic evaluation complete.");
      return;
    }

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
  }, [isDemoWorkbench]);

  const submitAnswerFeedback = useCallback(
    async (feedback) => {
      try {
        await requestAnswerFeedback({
          ...feedback,
          docIds: feedback.docIds ?? chatDocIds,
          sessionId,
          userId,
        });
      } catch (error) {
        const backendMessage =
          error.response?.data?.error ?? "Unable to save feedback.";
        message.error(backendMessage);
      }
    },
    [chatDocIds, sessionId, userId]
  );

  const resetPageScroll = useCallback(() => {
    if (navigator.userAgent.toLowerCase().includes("jsdom")) {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      return;
    }

    window.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }, []);

  const scrollSidebarSection = useCallback((ref) => {
    const section = ref.current;
    const sidebar = section?.closest(".archive-sidebar");

    if (!section || !sidebar) {
      return;
    }

    const targetTop = section.offsetTop - sidebar.offsetTop - 12;
    const nextTop = Math.max(0, targetTop);

    if (typeof sidebar.scrollTo === "function") {
      sidebar.scrollTo({
        behavior: "smooth",
        top: nextTop,
      });
      return;
    }

    sidebar.scrollTop = nextTop;
  }, []);

  const focusComposer = useCallback(() => {
    window.setTimeout(() => {
      document.getElementById("archive-agent-search")?.focus({
        preventScroll: true,
      });
    }, 180);
  }, []);

  const openSavedArxivSuggestion = useCallback(
    async (docId) => {
      const opened = await openSavedArxivSuggestionForDocument(docId);

      if (opened) {
        scrollSidebarSection(uploadRef);
        message.info("Reviewing saved arXiv recommendations.");
      }
    },
    [openSavedArxivSuggestionForDocument, scrollSidebarSection]
  );

  const selectConversationView = useCallback(
    (view) => {
      setActiveConversationView(view);
      resetPageScroll();
    },
    [resetPageScroll]
  );

  const handleComposerAttach = useCallback(() => {
    setActiveSidebarTarget("datasets");
    scrollSidebarSection(uploadRef);
    message.info("Use the Ingest dropzone to attach PDFs to this workspace.");
  }, [scrollSidebarSection]);

  const handleSidebarNavigate = useCallback(
    async (target) => {
      setActiveSidebarTarget(target);
      resetPageScroll();

      if (target === "new-chat") {
        if (isDemoWorkbench) {
          message.success("Demo chat is ready.");
          focusComposer();
          return;
        }

        await resetWorkspaceSession();
        message.success("Started a new chat.");
        focusComposer();
        return;
      }

      if (target === "search") {
        setActiveConversationView("chat");
        focusComposer();
        return;
      }

      if (target === "workspaces" || target === "datasets") {
        scrollSidebarSection(target === "datasets" ? uploadRef : documentListRef);
        return;
      }

      if (target === "agents") {
        setActiveConversationView("trace");
        return;
      }

      if (target === "evaluations") {
        scrollSidebarSection(qualityRef);
        return;
      }

      if (target === "settings") {
        message.info("Settings are not configured for this local workbench yet.");
      }
    },
    [
      focusComposer,
      isDemoWorkbench,
      resetPageScroll,
      resetWorkspaceSession,
      scrollSidebarSection,
    ]
  );

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void handleSidebarNavigate("search");
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleSidebarNavigate]);

  const visibleDocuments = isDemoWorkbench ? DEMO_DOCUMENTS : activeDocuments;
  const visibleConversation = isDemoWorkbench
    ? conversation.length > 0
      ? conversation
      : DEMO_CONVERSATION
    : conversation;
  const visibleActiveTurnIndex = isDemoWorkbench ? 0 : activeTurnIndex;
  const visibleCurrentTurn =
    visibleConversation[visibleActiveTurnIndex] ??
    (isDemoWorkbench ? DEMO_CONVERSATION[0] : currentTurn);
  const visibleRelevantDocuments = isDemoWorkbench
    ? DEMO_RELEVANT_DOCUMENTS
    : relevantDocuments;
  const visibleQualityReport =
    isDemoWorkbench && !qualityReport ? DEMO_QUALITY_REPORT : qualityReport;
  const visibleQualityHistory =
    isDemoWorkbench && !qualityHistory ? DEMO_QUALITY_HISTORY : qualityHistory;
  const visibleSelectedSource =
    selectedSource ?? (isDemoWorkbench ? DEMO_PREVIEW_SOURCE : null);
  const visibleTotalPages = isDemoWorkbench ? 182 : totalPages;
  const visiblePreviewStatus = isDemoWorkbench
    ? "Finance Policy Manual.pdf · Page 42"
    : previewStatus;
  const visibleDocLabel = isDemoWorkbench ? "Finance Policy QA" : chatDocLabel;
  const visibleTrace = visibleCurrentTurn?.answer?.agentTrace ?? [];
  const visibleSources = visibleCurrentTurn?.answer?.ragSources ?? [];
  const visibleTaskLog = isDemoWorkbench ? [] : taskLog;
  let visibleTasks = IDLE_TASKS;

  if (visibleTrace.length > 0) {
    visibleTasks = visibleTrace;
  }

  if (visibleTaskLog.length > 0) {
    visibleTasks = visibleTaskLog;
  }

  const renderConversationView = () => {
    if (activeConversationView === "trace") {
      return (
        <div className="archive-view-panel archive-trace-view">
          <div className="archive-view-panel-head">
            <span>Agent Trace</span>
            <strong>{visibleTrace.length} steps</strong>
          </div>
          <div className="archive-view-grid">
            {visibleTrace.map((step, index) => (
              <button
                key={step.id ?? `${step.label}-${index}`}
                type="button"
                className={`archive-view-item is-${step.status ?? "completed"}`}
                onClick={() => {
                  setActiveConversationView("chat");
                  message.info(`${step.label}: ${step.summary}`);
                }}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{step.label}</strong>
                <p>{step.summary}</p>
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (activeConversationView === "sources") {
      return (
        <div className="archive-view-panel archive-sources-view">
          <div className="archive-view-panel-head">
            <span>Sources</span>
            <strong>{visibleSources.length} cited</strong>
          </div>
          <div className="archive-view-grid">
            {visibleSources.map((source, index) => (
              <button
                key={`${source.docId}-${source.chunkIndex}-${source.rank}`}
                type="button"
                className={`archive-view-item ${
                  visibleSelectedSource?.docId === source.docId ? "is-selected" : ""
                }`}
                onClick={() => {
                  setSelectedSource(source);
                  message.success(`Previewing ${source.fileName}`);
                }}
              >
                <span>{index + 1}</span>
                <strong>{source.fileName}</strong>
                <p>{source.excerpt}</p>
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (activeConversationView === "tasks") {
      return (
        <div className="archive-view-panel archive-tasks-view">
          <div className="archive-view-panel-head">
            <span>Tasks</span>
            <strong>
              {isTaskLogLoading && !isDemoWorkbench
                ? "loading"
                : `${visibleTasks.length} active`}
            </strong>
          </div>
          <div className="archive-view-grid">
            {visibleTasks.map((task, index) => (
              <button
                key={task.id ?? `${task.label}-${index}`}
                type="button"
                className={`archive-view-item is-${task.status ?? "pending"}`}
                onClick={() => message.info(task.summary)}
              >
                <span>{formatTaskStatus(task.status)}</span>
                <strong>{task.label}</strong>
                <p>{task.summary}</p>
              </button>
            ))}
          </div>
        </div>
      );
    }

    return (
      <RenderQA
        conversation={visibleConversation}
        activeTurnIndex={visibleActiveTurnIndex}
        isLoading={isLoading}
        selectedSource={visibleSelectedSource}
        onSelectSource={setSelectedSource}
        onSelectTurn={isDemoWorkbench ? undefined : selectTurn}
        onFeedback={(feedback) => void submitAnswerFeedback(feedback)}
      />
    );
  };

  return (
    <div className="archive-shell">
      <Layout className="archive-layout">
        <Content className="archive-app">
          <header className="archive-global-header">
            <div className="archive-breadcrumb">
              <span>Workspaces</span>
              <span>/</span>
              <strong>Finance Policy QA</strong>
              <DownOutlined />
              <span className="archive-private-chip">
                <LockOutlined />
                Private
              </span>
            </div>

            <div className="archive-workbench-tabs" aria-label="Workspace summary">
              <button
                type="button"
                aria-label="Workspace documents summary"
                className="archive-workbench-tab is-active"
                onClick={() => void handleSidebarNavigate("workspaces")}
              >
                <FileSearchOutlined />
                {visibleDocuments.length} docs
              </button>
              <button
                type="button"
                aria-label="Conversation turns summary"
                className="archive-workbench-tab"
                onClick={() => selectConversationView("chat")}
              >
                <BranchesOutlined />
                {visibleConversation.length} turn
              </button>
              <button
                type="button"
                aria-label="Ready"
                className="archive-workbench-tab"
                onClick={() => message.success("AgentRAG is ready.")}
              >
                <SafetyCertificateOutlined />
                Ready
              </button>
            </div>

            <div className="archive-header-actions">
              <button
                type="button"
                aria-label="Help"
                onClick={() => message.info("Help is not configured in this local preview.")}
              >
                <QuestionCircleOutlined />
              </button>
              <button
                type="button"
                aria-label="Notifications"
                onClick={() => message.info("No new workspace notifications.")}
              >
                <BellOutlined />
              </button>
              <button
                type="button"
                className="archive-user-avatar"
                aria-label="Account"
                onClick={() => message.info("Signed in as Archive RAG demo user.")}
              >
                AK
              </button>
            </div>
          </header>

          <WorkspaceSidebar
            activeDocuments={visibleDocuments}
            activeNavTarget={activeSidebarTarget}
            arxivSuggestion={isDemoWorkbench ? null : arxivSuggestion}
            conversationCount={visibleConversation.length}
            currentTurn={visibleCurrentTurn}
            documentListRef={documentListRef}
            isArxivImporting={isArxivImporting}
            isArxivSuggestionLoading={
              isDemoWorkbench ? false : isArxivSuggestionLoading
            }
            isDemoWorkbench={isDemoWorkbench}
            isQualityLoading={isQualityLoading}
            onClearDocuments={clearDocuments}
            onDismissArxivSuggestion={clearArxivSuggestion}
            onImportArxivSuggestion={importArxivSuggestion}
            onOpenSavedArxivSuggestion={openSavedArxivSuggestion}
            onToggleChatScopeDocument={toggleChatScopeDocument}
            onLoadQualityHistory={loadQualityHistory}
            onLoadQualityLatest={loadLatestQualityReport}
            onRemoveDocument={removeDocument}
            onRunSyntheticQuality={runSyntheticQualityReport}
            onSelectSource={setSelectedSource}
            onNavigate={handleSidebarNavigate}
            onUploadSuccess={handleWorkspaceUploadSuccess}
            qualityHistory={visibleQualityHistory}
            qualityReport={visibleQualityReport}
            qualityRef={qualityRef}
            relevantDocuments={visibleRelevantDocuments}
            savedArxivSuggestionsByDocId={
              isDemoWorkbench ? {} : savedArxivSuggestionsByDocId
            }
            selectedChatDocIds={isDemoWorkbench ? [] : selectedChatDocIds}
            selectedDocId={visibleSelectedSource?.docId ?? selectedDocId}
            totalPages={visibleTotalPages}
            uploadRef={uploadRef}
            workspaceDocumentTotal={isDemoWorkbench ? 24 : visibleDocuments.length}
          />

          <section className="archive-preview-column">
            <div className="archive-main-header archive-preview-header">
              <div className="section-label">
                <span className="section-label-title">Preview</span>
                <span className="section-label-caption">{visiblePreviewStatus}</span>
              </div>
            </div>

            <div className="archive-card archive-preview-card">
              <PdfPreview source={visibleSelectedSource} />
            </div>
          </section>

          <section className="archive-main" ref={mainRef}>
            <div className="archive-main-header">
              <div className="section-label">
                <span className="section-label-title">
                  {isDemoWorkbench ? "Finance Policy QA" : "Conversation"}
                </span>
                <span className="section-label-caption">
                  {visibleDocuments.length > 0
                    ? `Working with ${visibleDocLabel}`
                    : "Agent workspace is empty"}
                </span>
              </div>
              <Text className="archive-meta-text">
                {visibleConversation.length} recorded turn
              </Text>
            </div>

            <div className="archive-workbench-nav" aria-label="Conversation views">
              {CONVERSATION_VIEWS.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={activeConversationView === view.id ? "is-active" : ""}
                  onClick={() => selectConversationView(view.id)}
                >
                  {view.label}
                </button>
              ))}
            </div>

            <div className="archive-card archive-conversation-card">
              {renderConversationView()}
            </div>

            <div className="archive-composer" ref={composerRef}>
              <ChatComponent
                chatScopeMode={chatScopeMode}
                chatScopeOptions={chatScopeOptions}
                docIds={isDemoWorkbench ? [] : chatDocIds}
                docLabel={visibleDocLabel}
                sessionId={sessionId}
                userId={userId}
                handleResp={handleResp}
                inputId="archive-agent-search"
                isLoading={isLoading}
                isDemoWorkbench={isDemoWorkbench}
                onChatScopeModeChange={setChatScopeMode}
                onAttach={handleComposerAttach}
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
