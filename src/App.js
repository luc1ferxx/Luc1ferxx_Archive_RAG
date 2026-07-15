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
import AgentRunCenter from "./components/AgentRunCenter";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import PdfUploader from "./components/PdfUploader";
import WorkspaceSidebar from "./components/WorkspaceSidebar";
import WorkspaceEntryPanel from "./components/WorkspaceEntryPanel";
import WorkspaceArtifactsPanel from "./components/WorkspaceArtifactsPanel";
import LocaleSwitch from "./components/LocaleSwitch";
import {
  fetchLatestQualityReport,
  fetchQualityHistory,
  requestAgentRunRecoveryAction,
  requestAgentRunAction,
  requestAgentRunStepRetry,
  requestAnswerFeedback,
  requestSyntheticQualityRun,
  requestTaskAction,
} from "./archiveApi";
import { isArxivDocument } from "./archiveWorkspace";
import { useChatSession } from "./hooks/useChatSession";
import { useArxivEnrichment } from "./hooks/useArxivEnrichment";
import { useAgentRunRecovery } from "./hooks/useAgentRunRecovery";
import { useDocumentSelection } from "./hooks/useDocumentSelection";
import { hasActiveTasks, useTaskLog } from "./hooks/useTaskLog";
import { useWorkspaceDocuments } from "./hooks/useWorkspaceDocuments";
import {
  DEMO_CONVERSATION,
  DEMO_DOCUMENTS,
  DEMO_PREVIEW_SOURCE,
  DEMO_QUALITY_HISTORY,
  DEMO_QUALITY_REPORT,
} from "./demoWorkbench";
import { getRecoveryActionSuccessMessage } from "./components/workbenchFormatters";
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

const CHAT_SCOPE_MODES = {
  uploaded: "uploaded",
  all: "all",
  selected: "selected",
};

const HOME_NAV_SECTIONS = new Set([
  "home",
  "skills",
  "workflows",
  "drive",
  "runs",
  "more",
]);

const getBackendErrorMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

const buildAgentRunActionAnswer = (currentAnswer = {}, result = {}) => {
  const run = result?.run;
  const nextAnswer = result?.response
    ? {
        ...result.response,
      }
    : {
        ...currentAnswer,
      };

  return {
    ...nextAnswer,
    agentRunRecovery: run?.recovery ?? nextAnswer.agentRunRecovery,
    agentRunStatus: run?.status ?? nextAnswer.agentRunStatus,
    agentRunSteps: run?.steps ?? nextAnswer.agentRunSteps,
    approvalGates: run?.approvalGates ?? nextAnswer.approvalGates,
  };
};

const App = () => {
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityHistory, setQualityHistory] = useState(null);
  const [qualityReport, setQualityReport] = useState(null);
  const [activeConversationView, setActiveConversationView] = useState("chat");
  const [activeWorkspaceNav, setActiveWorkspaceNav] = useState("workspace");
  const [locale, setLocale] = useState(getInitialLocale);
  const [chatScopeMode, setChatScopeMode] = useState(CHAT_SCOPE_MODES.uploaded);
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(false);
  const [activeHomeSection, setActiveHomeSection] = useState("home");
  const [homeDraftQuestion, setHomeDraftQuestion] = useState("");
  const [homeComposerResetKey, setHomeComposerResetKey] = useState(0);
  const [pendingHomeTask, setPendingHomeTask] = useState(null);
  const [selectedHomeSkillId, setSelectedHomeSkillId] = useState("document_rag");
  const [selectedChatDocIds, setSelectedChatDocIds] = useState([]);
  const mainRef = useRef(null);
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
    updateConversationTurn,
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
    requestSuggestions: requestArxivSuggestions,
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

  const handleWorkspaceUploadSuccess = useCallback(
    (document) => {
      handleUploadSuccess(document);
      void requestArxivSuggestions(document);
    },
    [handleUploadSuccess, requestArxivSuggestions]
  );
  const handleHomeUploadSuccess = useCallback(
    (document) => {
      handleWorkspaceUploadSuccess(document);
      setActiveHomeSection("drive");
    },
    [handleWorkspaceUploadSuccess]
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
        ? t("common.docs", { count: chatScopeDocuments.length })
        : t("common.noDocumentsInScope"),
    [chatScopeDocuments.length, t]
  );
  const chatScopeOptions = useMemo(
    () => [
      {
        count: uploadedDocuments.length,
        id: CHAT_SCOPE_MODES.uploaded,
        label: t("common.uploaded"),
      },
      {
        count: activeDocuments.length,
        id: CHAT_SCOPE_MODES.all,
        label: t("common.all"),
      },
      {
        count: selectedChatDocuments.length,
        id: CHAT_SCOPE_MODES.selected,
        label: t("common.selected"),
      },
    ],
    [activeDocuments.length, selectedChatDocuments.length, t, uploadedDocuments.length]
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

  const loadLatestQualityReport = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityReport(DEMO_QUALITY_REPORT);
      setQualityHistory(DEMO_QUALITY_HISTORY);
      message.success(t("app.demoQualityLoaded"));
      return;
    }

    setIsQualityLoading(true);

    try {
      setQualityReport(await fetchLatestQualityReport());
      setQualityHistory(await fetchQualityHistory());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? t("app.latestQualityFailed");
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  }, [isDemoWorkbench, t]);

  const loadQualityHistory = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityHistory(DEMO_QUALITY_HISTORY);
      message.success(t("app.demoQualityHistoryLoaded"));
      return;
    }

    setIsQualityLoading(true);

    try {
      setQualityHistory(await fetchQualityHistory());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? t("app.qualityHistoryFailed");
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  }, [isDemoWorkbench, t]);

  const runSyntheticQualityReport = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityReport(DEMO_QUALITY_REPORT);
      setQualityHistory(DEMO_QUALITY_HISTORY);
      message.success(t("app.demoSyntheticComplete"));
      return;
    }

    setIsQualityLoading(true);

    try {
      setQualityReport(await requestSyntheticQualityRun());
      setQualityHistory(await fetchQualityHistory());
      message.success(t("app.syntheticComplete"));
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? t("app.syntheticFailed");
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  }, [isDemoWorkbench, t]);

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
          error.response?.data?.error ?? t("app.feedbackFailed");
        message.error(backendMessage);
      }
    },
    [chatDocIds, sessionId, t, userId]
  );

  const handleAgentApprovalAction = useCallback(
    async ({ action, gate, turnIndex }) => {
      const turn = conversation[turnIndex];
      const runId = turn?.answer?.agentRunId;

      if (!runId || !gate?.id) {
        message.error(t("app.approvalMissing"));
        return;
      }

      setIsLoading(true);

      try {
        const result = await requestAgentRunAction(runId, action, {
          gateId: gate.id,
        });

        if (action === "approve" && result?.response) {
          const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

          updateConversationTurn(turnIndex, {
            question: turn.question,
            answer: nextAnswer,
          });
          setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
          await refreshAgentRunRecovery();
          message.success(t("app.approvalRecorded"));
          return;
        }

        const updatedGates = result?.run?.approvalGates ?? [];
        const updatedSteps = result?.run?.steps ?? [];

        updateConversationTurn(turnIndex, (currentTurn) => ({
          ...currentTurn,
          answer: {
            ...currentTurn.answer,
            agentAnswer: t("app.approvalDeniedAnswer"),
            agentRunStatus: result?.run?.status ?? currentTurn.answer?.agentRunStatus,
            agentRunSteps: updatedSteps,
            approvalGates: updatedGates,
            clarification: {
              ...(currentTurn.answer?.clarification ?? {}),
              needed: false,
            },
          },
        }));
        await refreshAgentRunRecovery();
        message.info(t("app.approvalDenied"));
      } catch (error) {
        const backendMessage =
          error.response?.data?.error ?? t("app.approvalMissing");
        message.error(backendMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateConversationTurn,
      t,
    ]
  );

  const handleAgentStepRetry = useCallback(
    async ({ step, turnIndex }) => {
      const turn = conversation[turnIndex];
      const runId = turn?.answer?.agentRunId;

      if (!runId || !step?.id) {
        message.error(t("app.retryMissing"));
        return;
      }

      setIsLoading(true);

      try {
        const result = await requestAgentRunStepRetry(runId, step.id);
        const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

        updateConversationTurn(turnIndex, {
          question: turn.question,
          answer: nextAnswer,
        });
        setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
        await refreshAgentRunRecovery();
        message.success(t("app.retryComplete"));
      } catch (error) {
        const backendMessage =
          error.response?.data?.error ?? t("app.retryFailed");
        message.error(backendMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateConversationTurn,
      t,
    ]
  );

  const handleAgentRecoveryAction = useCallback(
    async ({ action, runId, stepId, turnIndex }) => {
      const resolvedRunId = runId?.trim();
      const resolvedTurnIndex = Number.isInteger(turnIndex)
        ? turnIndex
        : conversation.findIndex(
            (turn) => turn?.answer?.agentRunId === resolvedRunId
          );
      const turn =
        resolvedTurnIndex >= 0 ? conversation[resolvedTurnIndex] : null;

      if (!resolvedRunId || !action) {
        message.error(t("app.recoverMissing"));
        return;
      }

      setIsLoading(true);

      try {
        const payload = stepId
          ? {
              stepId,
            }
          : {};
        const result = await requestAgentRunRecoveryAction(
          resolvedRunId,
          action,
          payload
        );

        if (turn) {
          const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

          updateConversationTurn(resolvedTurnIndex, {
            question: turn.question,
            answer: nextAnswer,
          });
          setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
        }

        await refreshAgentRunRecovery();
        message.success(getRecoveryActionSuccessMessage(action));
      } catch (error) {
        const backendMessage =
          error.response?.data?.error ?? t("app.recoverFailed");
        message.error(backendMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateConversationTurn,
      t,
    ]
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
    [focusComposer, t]
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
  }, [resetPageScroll]);

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
        if (isDemoWorkbench) {
          message.success(t("app.chatReady"));
          setIsWorkbenchOpen(false);
          focusComposer("archive-home-agent-search");
          return;
        }

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
        message.info(t("app.settingsUnavailable"));
      }
    },
    [
      focusComposer,
      isDemoWorkbench,
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
  const visibleQualityReport =
    isDemoWorkbench && !qualityReport ? DEMO_QUALITY_REPORT : qualityReport;
  const visibleQualityHistory =
    isDemoWorkbench && !qualityHistory ? DEMO_QUALITY_HISTORY : qualityHistory;
  const visibleSelectedSource =
    selectedSource ?? (isDemoWorkbench ? DEMO_PREVIEW_SOURCE : null);
  const visibleTotalPages = isDemoWorkbench ? 182 : totalPages;
  const visiblePreviewStatus = isDemoWorkbench
    ? `Finance Policy Manual.pdf · ${t("common.page")} 42`
    : previewStatus;
  const visibleDocLabel = isDemoWorkbench
    ? t("workbench.financePolicyQa")
    : chatDocLabel;
  const visibleTrace = visibleCurrentTurn?.answer?.agentTrace ?? [];
  const visibleSources = visibleCurrentTurn?.answer?.ragSources ?? [];
  const visibleTaskLog = isDemoWorkbench ? [] : taskLog;
  const visibleRecoveryRuns = isDemoWorkbench ? [] : recoveryRuns;
  const hasActiveTaskLog = hasActiveTasks(visibleTaskLog);
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

  if (visibleTrace.length > 0) {
    visibleTasks = visibleTrace;
  }

  if (visibleTaskLog.length > 0) {
    visibleTasks = visibleTaskLog;
  }

  useEffect(() => {
    if (isDemoWorkbench || !hasActiveTaskLog) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refreshTaskLog();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActiveTaskLog, isDemoWorkbench, refreshTaskLog]);

  useEffect(() => {
    if (isDemoWorkbench) {
      return;
    }

    if (hadActiveTasksRef.current && !hasActiveTaskLog) {
      void refreshDocuments();
      void loadSavedArxivSuggestions();
    }

    hadActiveTasksRef.current = hasActiveTaskLog;
  }, [
    hasActiveTaskLog,
    isDemoWorkbench,
    loadSavedArxivSuggestions,
    refreshDocuments,
  ]);

  const renderConversationView = () => {
    if (activeConversationView === "trace") {
      return (
        <div className="archive-view-panel archive-trace-view">
          <div className="archive-view-panel-head">
            <span>{t("workbench.agentTrace")}</span>
            <strong>{t("workbench.steps", { count: visibleTrace.length })}</strong>
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
            <span>{t("workbench.sources")}</span>
            <strong>{t("common.cited", { count: visibleSources.length })}</strong>
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
          isLoading={(isTaskLogLoading || isRecoveryLoading) && !isDemoWorkbench}
          onTaskAction={isDemoWorkbench ? undefined : handleTaskAction}
          tasks={visibleTasks}
        />
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
        onApprovalAction={
          isDemoWorkbench
            ? undefined
            : (payload) => void handleAgentApprovalAction(payload)
        }
        onContinueRun={
          isDemoWorkbench
            ? undefined
            : (payload) => handleAgentRunContinue(payload)
        }
        onFeedback={(feedback) => void submitAnswerFeedback(feedback)}
        onStepRetry={
          isDemoWorkbench
            ? undefined
            : (payload) => void handleAgentStepRetry(payload)
        }
      />
    );
  };

  const renderAgentComposer = ({ inputId, ref, resetKey, showQuickActions = false } = {}) => (
    <div className="archive-composer" ref={ref}>
      <ChatComponent
        chatScopeMode={chatScopeMode}
        chatScopeOptions={chatScopeOptions}
        draftQuestion={inputId === "archive-home-agent-search" ? homeDraftQuestion : ""}
        docIds={isWorkbenchOpen && isDemoWorkbench ? [] : chatDocIds}
        docLabel={isWorkbenchOpen && isDemoWorkbench ? visibleDocLabel : chatDocLabel}
        sessionId={sessionId}
        userId={userId}
        handleResp={handleResp}
        inputId={inputId}
        isLoading={isLoading}
        isDemoWorkbench={isWorkbenchOpen && isDemoWorkbench}
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
          artifactSlot={<WorkspaceArtifactsPanel locale={locale} t={t} />}
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
          languageSlot={
            <LocaleSwitch
              locale={locale}
              onLocaleChange={handleLocaleChange}
              t={t}
            />
          }
          uploadSlot={
            <div ref={homeUploadRef}>
              <PdfUploader onUploadSuccess={handleHomeUploadSuccess} />
            </div>
          }
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
            <div className="archive-breadcrumb">
              <span>{t("app.workspaces")}</span>
              <span>/</span>
              <strong>{t("workbench.financePolicyQa")}</strong>
              <DownOutlined />
              <span className="archive-private-chip">
                <LockOutlined />
                {t("app.private")}
              </span>
            </div>

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
                {t("app.docsSummary", { count: visibleDocuments.length })}
              </button>
              <button
                type="button"
                aria-label={t("app.conversationTurnsSummary")}
                className="archive-workbench-tab"
                onClick={() => selectConversationView("chat")}
              >
                <BranchesOutlined />
                {t("app.turnShort", { count: visibleConversation.length })}
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
              <button
                type="button"
                className="archive-user-avatar"
                aria-label={t("app.account")}
                onClick={() => message.info(t("app.signedInDemo"))}
              >
                AK
              </button>
            </div>
          </header>

          <WorkspaceSidebar
            activeNavItem={activeWorkspaceNav}
            activeDocuments={visibleDocuments}
            arxivSuggestion={isDemoWorkbench ? null : arxivSuggestion}
            conversationCount={visibleConversation.length}
            documentListRef={documentListRef}
            isArxivImporting={isArxivImporting}
            isActionPending={isLoading}
            isRecoveryLoading={isDemoWorkbench ? false : isRecoveryLoading}
            isArxivSuggestionLoading={
              isDemoWorkbench ? false : isArxivSuggestionLoading
            }
            isDemoWorkbench={isDemoWorkbench}
            isQualityLoading={isQualityLoading}
            onClearDocuments={clearDocuments}
            onDismissArxivSuggestion={clearArxivSuggestion}
            onImportArxivSuggestion={importArxivSuggestion}
            onOpenSavedArxivSuggestion={openSavedArxivSuggestion}
            onRecoveryAction={
              isDemoWorkbench
                ? undefined
                : (payload) => void handleAgentRecoveryAction(payload)
            }
            onToggleChatScopeDocument={toggleChatScopeDocument}
            onLoadQualityHistory={loadQualityHistory}
            onLoadQualityLatest={loadLatestQualityReport}
            onRemoveDocument={removeDocument}
            onRunSyntheticQuality={runSyntheticQualityReport}
            onNavigate={handleSidebarNavigate}
            onUploadSuccess={handleWorkspaceUploadSuccess}
            qualityHistory={visibleQualityHistory}
            qualityReport={visibleQualityReport}
            qualityRef={qualityRef}
            recoveryRuns={visibleRecoveryRuns}
            savedArxivSuggestionsByDocId={
              isDemoWorkbench ? {} : savedArxivSuggestionsByDocId
            }
            selectedChatDocIds={isDemoWorkbench ? [] : selectedChatDocIds}
            locale={locale}
            t={t}
            totalPages={visibleTotalPages}
            uploadRef={uploadRef}
            workspaceDocumentTotal={isDemoWorkbench ? 24 : visibleDocuments.length}
          />

          <section className="archive-preview-column">
            <div className="archive-main-header archive-preview-header">
              <div className="section-label">
                <span className="section-label-title">{t("app.preview")}</span>
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
                  {isDemoWorkbench
                    ? t("workbench.financePolicyQa")
                    : t("app.conversation")}
                </span>
                <span className="section-label-caption">
                  {visibleDocuments.length > 0
                    ? t("app.workingWith", { label: visibleDocLabel })
                    : t("app.agentWorkspaceEmpty")}
                </span>
              </div>
              <Text className="archive-meta-text">
                {t("app.recordedTurn", {
                  count: visibleConversation.length,
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
