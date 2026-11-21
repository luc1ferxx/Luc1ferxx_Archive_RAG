import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout, Typography, message } from "antd";
import {
  BellOutlined,
  BranchesOutlined,
  FileSearchOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import ChatComponent from "./components/ChatComponent";
import AgentRunCenter from "./components/AgentRunCenter";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import PdfUploader from "./components/PdfUploader";
import WorkspaceSidebar from "./components/WorkspaceSidebar";
import WorkspaceEntryPanel from "./components/WorkspaceEntryPanel";
import WorkspaceArtifactsPanel from "./components/WorkspaceArtifactsPanel";
import LocaleSwitch from "./components/LocaleSwitch";
import AuthStatus from "./auth/AuthStatus";
import WorkspaceSwitcher from "./auth/WorkspaceSwitcher";
import { useAuth } from "./auth/AuthProvider";
import {
  requestAnswerFeedback,
  requestTaskAction,
} from "./archiveApi";
import { useChatSession } from "./hooks/useChatSession";
import { useArxivEnrichment } from "./hooks/useArxivEnrichment";
import { useAgentRunActions } from "./hooks/useAgentRunActions";
import { useAgentRunRecovery } from "./hooks/useAgentRunRecovery";
import { useChatScope, CHAT_SCOPE_MODES } from "./hooks/useChatScope";
import { useDocumentSelection } from "./hooks/useDocumentSelection";
import { useQualityReports } from "./hooks/useQualityReports";
import { hasActiveTasks, useTaskLog } from "./hooks/useTaskLog";
import { useWorkspaceDocuments } from "./hooks/useWorkspaceDocuments";
import { withDocumentMimeType } from "./archiveWorkspace";
import {
  createTranslator,
  getInitialLocale,
  LOCALE_STORAGE_KEY,
} from "./archiveI18n";
import "./App.css";

const CONVERSATION_VIEWS = [
  { id: "chat", labelKey: "view.chat" },
  { id: "trace", labelKey: "view.trace" },
  { id: "sources", labelKey: "view.sources" },
  { id: "tasks", labelKey: "view.tasks" },
];

const HOME_NAV_SECTIONS = new Set([
  "home",
  "skills",
  "workflows",
  "drive",
  "runs",
  "more",
]);

const EMPTY_ARRAY = [];

const getBackendErrorMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

const App = () => {
  const [activeConversationView, setActiveConversationView] = useState("chat");
  const [activeWorkspaceNav, setActiveWorkspaceNav] = useState("workspace");
  const [locale, setLocale] = useState(getInitialLocale);
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(false);
  const [activeHomeSection, setActiveHomeSection] = useState("home");
  const [homeDraftQuestion, setHomeDraftQuestion] = useState("");
  const [homeComposerResetKey, setHomeComposerResetKey] = useState(0);
  const [pendingHomeTask, setPendingHomeTask] = useState(null);
  const [selectedHomeSkillId, setSelectedHomeSkillId] = useState("document_rag");
  const mainRef = useRef(null);
  const { can: canUseCapability, status: authStatus } = useAuth();
  const canUpload = canUseCapability("upload");
  const canDelete = canUseCapability("delete");
  const canAdmin = canUseCapability("admin");
  const composerRef = useRef(null);
  const homeUploadRef = useRef(null);
  const hadActiveTasksRef = useRef(false);
  const uploadRef = useRef(null);
  const documentListRef = useRef(null);
  const qualityRef = useRef(null);
  const { Content } = Layout;
  const { Text } = Typography;
  const t = useMemo(() => createTranslator(locale), [locale]);
  const handleLocaleChange = useCallback((nextLocale) => {
    setLocale(nextLocale);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
  }, []);
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
    updateTurnByRunId,
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
  const {
    clearRecoveryRuns,
    isRecoveryLoading,
    loadRecoveryRuns,
    runs: recoveryRuns,
  } = useAgentRunRecovery();
  const refreshTaskLog = useCallback(
    () =>
      loadTasks({
        silent: true,
      }),
    [loadTasks]
  );
  const handleTaskAction = useCallback(
    async (task, action, payload = {}) => {
      if (!task?.id || !action) {
        return;
      }

      try {
        await requestTaskAction(task.id, action, payload);
        message.success(t("app.taskUpdated"));
        await refreshTaskLog();
      } catch (error) {
        message.warning(
          getBackendErrorMessage(error, t("app.taskUpdateFailed"))
        );
      }
    },
    [refreshTaskLog, t]
  );
  const refreshAgentRunRecovery = useCallback(
    () =>
      loadRecoveryRuns({
        silent: true,
      }),
    [loadRecoveryRuns]
  );
  const {
    clearSuggestion: clearArxivSuggestion,
    clearSavedSuggestions: clearSavedArxivSuggestions,
    importSuggestion: importArxivSuggestion,
    isImporting: isArxivImporting,
    isSuggestionLoading: isArxivSuggestionLoading,
    loadSavedSuggestions: loadSavedArxivSuggestions,
    openSavedSuggestion: openSavedArxivSuggestionForDocument,
    requestSuggestions: requestArxivSuggestionsForDocument,
    savedSuggestionsByDocId: savedArxivSuggestionsByDocId,
    suggestion: arxivSuggestion,
  } = useArxivEnrichment({
    onImportComplete: refreshDocuments,
    onTaskChange: refreshTaskLog,
  });
  const {
    previewStatus,
    resetSelection,
    selectedSource,
    selectTurn,
    setSelectedSource,
  } = useDocumentSelection({
    activeDocuments,
    conversation,
    currentTurn,
    setActiveTurnIndex,
    t,
  });

  const {
    chatDocIds,
    chatDocLabel,
    chatScopeMode,
    chatScopeOptions,
    selectedChatDocIds,
    setChatScopeMode,
    setSelectedChatDocIds,
    toggleChatScopeDocument,
  } = useChatScope({ activeDocuments, t });

  const {
    isQualityLoading,
    loadLatestQualityReport,
    loadQualityHistory,
    qualityHistory,
    qualityReport,
    runSyntheticQualityReport,
  } = useQualityReports({ t });

  const {
    handleAgentApprovalAction,
    handleAgentRecoveryAction,
    handleAgentStepRetry,
  } = useAgentRunActions({
    conversation,
    refreshAgentRunRecovery,
    setIsLoading,
    setSelectedSource,
    updateTurnByRunId,
    t,
  });

  const resetWorkspaceSession = useCallback(async () => {
    resetConversation();
    resetSelection();
    await rotateSession();
  }, [resetConversation, resetSelection, rotateSession]);

  const handleResp = useCallback(
    (question, answer) => {
      setIsWorkbenchOpen(true);
      setHomeDraftQuestion("");
      setPendingHomeTask(null);
      setActiveConversationView("chat");
      setActiveWorkspaceNav("workspace");
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
          await refreshAgentRunRecovery();
          await resetWorkspaceSession();
        },
      }),
    [
      arxivSuggestion?.document?.docId,
      clearArxivSuggestion,
      removeWorkspaceDocument,
      refreshAgentRunRecovery,
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
          clearRecoveryRuns();
          clearTasks();
          await resetWorkspaceSession();
        },
      }),
    [
      clearArxivSuggestion,
      clearSavedArxivSuggestions,
      clearRecoveryRuns,
      clearWorkspaceDocuments,
      clearTasks,
      resetWorkspaceSession,
    ]
  );

  const handleHomeUploadSuccess = useCallback(
    (document) => {
      handleUploadSuccess(document);
      setActiveHomeSection("drive");
    },
    [handleUploadSuccess]
  );

  const submitAnswerFeedback = useCallback(
    async (feedback) => {
      try {
        await requestAnswerFeedback({
          ...feedback,
          docIds: feedback.docIds ?? chatDocIds,
          sessionId,
        });
      } catch (error) {
        const backendMessage =
          error.response?.data?.error ?? t("app.feedbackFailed");
        message.error(backendMessage);
      }
    },
    [chatDocIds, sessionId, t]
  );

  const activeDocumentIdsKey = useMemo(
    () => activeDocuments.map((document) => document.docId).join("\n"),
    [activeDocuments]
  );

  useEffect(() => {
    if (!activeDocumentIdsKey) {
      clearSavedArxivSuggestions();
      clearRecoveryRuns();
      clearTasks();
      return;
    }

    void loadSavedArxivSuggestions({
      merge: true,
    });
    void refreshAgentRunRecovery();
    void refreshTaskLog();
  }, [
    activeDocumentIdsKey,
    clearRecoveryRuns,
    clearSavedArxivSuggestions,
    clearTasks,
    loadSavedArxivSuggestions,
    refreshAgentRunRecovery,
    refreshTaskLog,
  ]);

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

  const focusComposer = useCallback((inputId = "archive-agent-search") => {
    window.setTimeout(() => {
      document.getElementById(inputId)?.focus({
        preventScroll: true,
      });
    }, 180);
  }, []);

  const openSavedArxivSuggestion = useCallback(
    async (docId) => {
      const opened = await openSavedArxivSuggestionForDocument(docId);

      if (opened) {
        scrollSidebarSection(uploadRef);
        message.info(t("app.reviewingSavedArxiv"));
      }
    },
    [openSavedArxivSuggestionForDocument, scrollSidebarSection, t]
  );
  // The panel shows its loading state at once, so scroll to it on the click;
  // a search that finds nothing shows no panel, so it says so.
  const requestArxivSuggestions = useCallback(
    async (document) => {
      scrollSidebarSection(uploadRef);
      const result = await requestArxivSuggestionsForDocument(document);

      if (result && (result.papers ?? []).length === 0) {
        message.info(
          t(
            result.reason === "external_query_blocked"
              ? "app.arxivQueryBlocked"
              : "app.arxivNoMatches"
          )
        );
      }
    },
    [requestArxivSuggestionsForDocument, scrollSidebarSection, t]
  );

  const selectConversationView = useCallback(
    (view) => {
      if (view === "tasks" || view === "trace") {
        setActiveWorkspaceNav("runs");
      }

      if (view === "sources") {
        setActiveWorkspaceNav("drive");
      }

      setActiveConversationView(view);
      resetPageScroll();
    },
    [resetPageScroll]
  );

  const handleAgentRunContinue = useCallback(
    ({ turnIndex }) => {
      selectTurn(turnIndex);
      setActiveConversationView("chat");
      resetPageScroll();
      message.info(t("app.agentRunSelected"));
    },
    [resetPageScroll, selectTurn, t]
  );

  const handleComposerAttach = useCallback(() => {
    scrollSidebarSection(uploadRef);
    message.info(t("app.searchAttachHint"));
  }, [scrollSidebarSection, t]);
  const handleHomeUploadClick = useCallback(() => {
    setActiveHomeSection("drive");
    window.setTimeout(() => {
      homeUploadRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
  }, []);

  const openWorkbench = useCallback(
    ({ nav = "workspace", view = "chat" } = {}) => {
      setIsWorkbenchOpen(true);
      setActiveWorkspaceNav(nav);
      setActiveConversationView(view);
      resetPageScroll();
    },
    [resetPageScroll]
  );

  const handleHomeSkillSelect = useCallback(
    (skill) => {
      setSelectedHomeSkillId(skill?.id ?? "document_rag");
      setActiveHomeSection(skill?.id === "compare_documents" ? "workflows" : "skills");
      resetPageScroll();
    },
    [resetPageScroll]
  );

  const handleHomeDraftQuestionConsumed = useCallback(() => {
    setHomeDraftQuestion("");
  }, []);

  const handleHomePrepareTask = useCallback(
    ({ documentIds = [], question = "", skill } = {}) => {
      const nextDocumentIds = documentIds.filter(Boolean);

      if (nextDocumentIds.length > 0) {
        setSelectedChatDocIds(nextDocumentIds);
        setChatScopeMode(CHAT_SCOPE_MODES.selected);
      }

      if (skill?.id) {
        setSelectedHomeSkillId(skill.id);
      }

      setHomeDraftQuestion(question);
      setPendingHomeTask({
        documentCount: nextDocumentIds.length,
        question,
        skillId: skill?.id ?? "document_rag",
      });
      focusComposer("archive-home-agent-search");
      message.success(
        t("app.taskReady", {
          skill: t(skill?.labelKey ?? "skill.document.label"),
        })
      );
    },
    [focusComposer, setChatScopeMode, setSelectedChatDocIds, t]
  );

  const handleHomeNavigate = useCallback(
    (target) => {
      if (HOME_NAV_SECTIONS.has(target)) {
        setActiveHomeSection(target);
        setIsWorkbenchOpen(false);
        resetPageScroll();
        return;
      }

      openWorkbench({
        nav: "workspace",
        view: "chat",
      });
    },
    [openWorkbench, resetPageScroll]
  );

  const handleHomeNew = useCallback(() => {
    setActiveHomeSection("home");
    setIsWorkbenchOpen(false);
    setHomeDraftQuestion("");
    setPendingHomeTask(null);
    setSelectedHomeSkillId("document_rag");
    setSelectedChatDocIds([]);
    setChatScopeMode(CHAT_SCOPE_MODES.uploaded);
    setHomeComposerResetKey((currentKey) => currentKey + 1);
    resetPageScroll();
  }, [resetPageScroll, setChatScopeMode, setSelectedChatDocIds]);

  const handleSidebarNavigate = useCallback(
    async (target) => {
      const navTargetByAction = {
        drive: "drive",
        runs: "runs",
        skills: "skills",
        workflows: "workflows",
        workspaces: "workspace",
      };

      if (navTargetByAction[target]) {
        setActiveWorkspaceNav(navTargetByAction[target]);
      }

      resetPageScroll();

      if (target === "new-chat") {
        setActiveHomeSection("home");
        await resetWorkspaceSession();
        message.success(t("app.startedNewChat"));
        setIsWorkbenchOpen(false);
        return;
      }

      if (target === "skills") {
        setActiveConversationView("chat");
        focusComposer();
        return;
      }

      if (target === "workflows") {
        setActiveConversationView("tasks");
        message.info(t("app.workflowsHint"));
        return;
      }

      if (target === "drive") {
        scrollSidebarSection(uploadRef);
        return;
      }

      if (target === "runs") {
        setActiveConversationView("tasks");
        return;
      }

      if (target === "search") {
        setActiveConversationView("chat");
        focusComposer();
        return;
      }

      if (target === "workspaces") {
        scrollSidebarSection(documentListRef);
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
        message.info(t("app.settingsUnavailable"));
      }
    },
    [
      focusComposer,
      resetPageScroll,
      resetWorkspaceSession,
      scrollSidebarSection,
      t,
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

  // Citations carry no MIME type; the preview takes the document's, so a
  // Word, PowerPoint or Excel source offers its download instead of the PDF
  // viewer (a PDF source is passed on unchanged).
  const previewSource = useMemo(
    () => withDocumentMimeType(selectedSource, activeDocuments),
    [activeDocuments, selectedSource]
  );
  const currentTrace = currentTurn?.answer?.agentTrace ?? EMPTY_ARRAY;
  const currentSources = currentTurn?.answer?.ragSources ?? EMPTY_ARRAY;
  const hasActiveTaskLog = hasActiveTasks(taskLog);
  const idleTasks = useMemo(
    () => [
      {
        id: "idle-task",
        label: t("tasks.idle.label"),
        status: "pending",
        summary: t("tasks.idle.summary"),
      },
    ],
    [t]
  );
  let visibleTasks = idleTasks;

  if (currentTrace.length > 0) {
    visibleTasks = currentTrace;
  }

  if (taskLog.length > 0) {
    visibleTasks = taskLog;
  }

  useEffect(() => {
    if (!hasActiveTaskLog) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refreshTaskLog();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActiveTaskLog, refreshTaskLog]);

  useEffect(() => {
    if (hadActiveTasksRef.current && !hasActiveTaskLog) {
      void refreshDocuments();
      void loadSavedArxivSuggestions();
    }

    hadActiveTasksRef.current = hasActiveTaskLog;
  }, [hasActiveTaskLog, loadSavedArxivSuggestions, refreshDocuments]);

  const renderQAFeedback = useCallback(
    (feedback) => void submitAnswerFeedback(feedback),
    [submitAnswerFeedback]
  );
  const artifactSlot = useMemo(
    () => <WorkspaceArtifactsPanel locale={locale} t={t} />,
    [locale, t]
  );
  const languageSlot = useMemo(
    () => (
      <>
        <WorkspaceSwitcher t={t} />
        <AuthStatus t={t} />
        <LocaleSwitch locale={locale} onLocaleChange={handleLocaleChange} t={t} />
      </>
    ),
    [handleLocaleChange, locale, t]
  );
  const uploadSlot = useMemo(
    () => (
      <div ref={homeUploadRef}>
        {canUpload ? (
          <PdfUploader onUploadSuccess={handleHomeUploadSuccess} t={t} />
        ) : (
          <p className="archive-permission-note" role="note">
            {t(authStatus === "signed_in" ? "auth.uploadNotAllowed" : "auth.signInRequired")}
          </p>
        )}
      </div>
    ),
    [authStatus, canUpload, handleHomeUploadSuccess, t]
  );

  const renderConversationView = () => {
    if (activeConversationView === "trace") {
      return (
        <div className="archive-view-panel archive-trace-view">
          <div className="archive-view-panel-head">
            <span>{t("workbench.agentTrace")}</span>
            <strong>{t("workbench.steps", { count: currentTrace.length })}</strong>
          </div>
          <div className="archive-view-grid">
            {currentTrace.map((step, index) => (
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
            <span>{t("workbench.sources")}</span>
            <strong>{t("common.cited", { count: currentSources.length })}</strong>
          </div>
          <div className="archive-view-grid">
            {currentSources.map((source, index) => (
              <button
                key={`${source.docId}-${source.chunkIndex}-${source.rank}`}
                type="button"
                className={`archive-view-item ${
                  selectedSource?.docId === source.docId ? "is-selected" : ""
                }`}
                onClick={() => {
                  setSelectedSource(source);
                  message.success(
                    t("workbench.previewing", {
                      fileName: source.fileName,
                    })
                  );
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
        <AgentRunCenter
          isLoading={isTaskLogLoading || isRecoveryLoading}
          onTaskAction={handleTaskAction}
          t={t}
          tasks={visibleTasks}
        />
      );
    }

    return (
      <RenderQA
        conversation={conversation}
        activeTurnIndex={activeTurnIndex}
        isLoading={isLoading}
        selectedSource={selectedSource}
        onSelectSource={setSelectedSource}
        onSelectTurn={selectTurn}
        onApprovalAction={handleAgentApprovalAction}
        onContinueRun={handleAgentRunContinue}
        onFeedback={renderQAFeedback}
        onStepRetry={handleAgentStepRetry}
        t={t}
      />
    );
  };

  const renderAgentComposer = ({ inputId, ref, resetKey, showQuickActions = false } = {}) => (
    <div className="archive-composer" ref={ref}>
      <ChatComponent
        chatScopeMode={chatScopeMode}
        chatScopeOptions={chatScopeOptions}
        draftQuestion={inputId === "archive-home-agent-search" ? homeDraftQuestion : ""}
        docIds={chatDocIds}
        docLabel={chatDocLabel}
        sessionId={sessionId}
        handleResp={handleResp}
        inputId={inputId}
        isLoading={isLoading}
        onChatScopeModeChange={setChatScopeMode}
        onDraftQuestionConsumed={handleHomeDraftQuestionConsumed}
        onAttach={isWorkbenchOpen ? handleComposerAttach : handleHomeUploadClick}
        resetKey={resetKey}
        setIsLoading={setIsLoading}
        showQuickActions={showQuickActions}
        locale={locale}
        t={t}
      />
    </div>
  );

  if (!isWorkbenchOpen) {
    return (
      <div className="archive-shell archive-home-shell">
        <WorkspaceEntryPanel
          activeSection={activeHomeSection}
          artifactSlot={artifactSlot}
          documentCount={activeDocuments.length}
          documents={activeDocuments}
          onNavigate={handleHomeNavigate}
          onNew={handleHomeNew}
          onOpenWorkspace={openWorkbench}
          onPrepareTask={handleHomePrepareTask}
          onSkillSelect={handleHomeSkillSelect}
          onUploadClick={handleHomeUploadClick}
          pageCount={totalPages}
          pendingTask={pendingHomeTask}
          recoveryRuns={recoveryRuns}
          selectedSkillId={selectedHomeSkillId}
          taskCount={taskLog.length + recoveryRuns.length}
          tasks={taskLog}
          t={t}
          languageSlot={languageSlot}
          uploadSlot={uploadSlot}
        >
          {renderAgentComposer({
            inputId: "archive-home-agent-search",
            ref: null,
            resetKey: homeComposerResetKey,
            showQuickActions: true,
          })}
        </WorkspaceEntryPanel>
      </div>
    );
  }

  return (
    <div className="archive-shell">
      <Layout className="archive-layout">
        <Content className="archive-app">
          <header className="archive-global-header">
            <div
              className="archive-workbench-tabs"
              aria-label={t("app.workspaceSummary")}
            >
              <button
                type="button"
                aria-label={t("app.workspaceDocumentsSummary")}
                className="archive-workbench-tab is-active"
                onClick={() => void handleSidebarNavigate("workspaces")}
              >
                <FileSearchOutlined />
                {t("app.docsSummary", { count: activeDocuments.length })}
              </button>
              <button
                type="button"
                aria-label={t("app.conversationTurnsSummary")}
                className="archive-workbench-tab"
                onClick={() => selectConversationView("chat")}
              >
                <BranchesOutlined />
                {t("app.turnShort", { count: conversation.length })}
              </button>
              <button
                type="button"
                aria-label={t("workbench.ready")}
                className="archive-workbench-tab"
                onClick={() => message.success(t("app.agentReady"))}
              >
                <SafetyCertificateOutlined />
                {t("workbench.ready")}
              </button>
            </div>

            <div className="archive-header-actions">
              <WorkspaceSwitcher t={t} />
              <AuthStatus t={t} />
              <LocaleSwitch
                locale={locale}
                onLocaleChange={handleLocaleChange}
                t={t}
              />
              <button
                type="button"
                aria-label={t("app.help")}
                onClick={() => message.info(t("app.helpUnavailable"))}
              >
                <QuestionCircleOutlined />
              </button>
              <button
                type="button"
                aria-label={t("app.notifications")}
                onClick={() => message.info(t("app.noNotifications"))}
              >
                <BellOutlined />
              </button>
            </div>
          </header>

          <WorkspaceSidebar
            activeNavItem={activeWorkspaceNav}
            activeDocuments={activeDocuments}
            authStatus={authStatus}
            canAdmin={canAdmin}
            canDelete={canDelete}
            canUpload={canUpload}
            arxivSuggestion={arxivSuggestion}
            conversationCount={conversation.length}
            documentListRef={documentListRef}
            isArxivImporting={isArxivImporting}
            isActionPending={isLoading}
            isRecoveryLoading={isRecoveryLoading}
            isArxivSuggestionLoading={isArxivSuggestionLoading}
            isQualityLoading={isQualityLoading}
            onClearDocuments={clearDocuments}
            onDismissArxivSuggestion={clearArxivSuggestion}
            onImportArxivSuggestion={importArxivSuggestion}
            onOpenSavedArxivSuggestion={openSavedArxivSuggestion}
            onRecoveryAction={handleAgentRecoveryAction}
            onRequestArxivSuggestions={requestArxivSuggestions}
            onToggleChatScopeDocument={toggleChatScopeDocument}
            onLoadQualityHistory={loadQualityHistory}
            onLoadQualityLatest={loadLatestQualityReport}
            onRemoveDocument={removeDocument}
            onRunSyntheticQuality={runSyntheticQualityReport}
            onNavigate={handleSidebarNavigate}
            onUploadSuccess={handleUploadSuccess}
            qualityHistory={qualityHistory}
            qualityReport={qualityReport}
            qualityRef={qualityRef}
            recoveryRuns={recoveryRuns}
            savedArxivSuggestionsByDocId={savedArxivSuggestionsByDocId}
            selectedChatDocIds={selectedChatDocIds}
            locale={locale}
            t={t}
            totalPages={totalPages}
            uploadRef={uploadRef}
          />

          <section className="archive-preview-column">
            <div className="archive-main-header archive-preview-header">
              <div className="section-label">
                <span className="section-label-title">{t("app.preview")}</span>
                <span className="section-label-caption">{previewStatus}</span>
              </div>
            </div>

            <div className="archive-card archive-preview-card">
              <PdfPreview source={previewSource} t={t} />
            </div>
          </section>

          <section className="archive-main" ref={mainRef}>
            <div className="archive-main-header">
              <div className="section-label">
                <span className="section-label-title">{t("app.conversation")}</span>
                <span className="section-label-caption">
                  {activeDocuments.length > 0
                    ? t("app.workingWith", { label: chatDocLabel })
                    : t("app.agentWorkspaceEmpty")}
                </span>
              </div>
              <Text className="archive-meta-text">
                {t("app.recordedTurn", {
                  count: conversation.length,
                })}
              </Text>
            </div>

            <div
              className="archive-workbench-nav"
              aria-label={t("workbench.conversationViews")}
            >
              {CONVERSATION_VIEWS.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={activeConversationView === view.id ? "is-active" : ""}
                  onClick={() => selectConversationView(view.id)}
                >
                  {t(view.labelKey)}
                </button>
              ))}
            </div>

            <div className="archive-card archive-conversation-card">
              {renderConversationView()}
            </div>

            {renderAgentComposer({
              inputId: "archive-agent-search",
              ref: composerRef,
            })}
          </section>
        </Content>
      </Layout>
    </div>
  );
};

export default App;
