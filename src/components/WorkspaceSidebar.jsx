import { memo } from "react";
import { Button, Popconfirm } from "antd";
import {
  AppstoreOutlined,
  BranchesOutlined,
  CheckSquareOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  PlusCircleOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  formatPageCount,
  getDocumentSource,
  isArxivDocument,
} from "../archiveWorkspace";
import { formatDocumentUnitCount } from "../documentLocation";
import DocumentProfileSnippet from "./DocumentProfileSnippet";
import ArxivSuggestionPanel from "./ArxivSuggestionPanel";
import PdfUploader from "./PdfUploader";
import QualityGuardPanel from "./QualityGuardPanel";
import {
  formatRecoveryActionLabel,
  formatStatusLabel,
  formatStepLabel,
} from "./workbenchFormatters";

const defaultT = (key, values = {}) =>
  Object.entries(values).reduce(
    (result, [valueKey, value]) => result.split(`{${valueKey}}`).join(String(value)),
    key
  );

const getDocumentSourceLabel = (document, t) => {
  const source = getDocumentSource(document);

  if (isArxivDocument(document)) {
    return source?.arxivId ? `arXiv ${source.arxivId}` : "arXiv";
  }

  return t("sidebar.uploaded");
};

const WORKSPACE_NAV_ITEMS = [
  {
    icon: AppstoreOutlined,
    id: "workspace",
    labelKey: "sidebar.workspace",
    target: "workspaces",
  },
  {
    icon: BranchesOutlined,
    id: "skills",
    labelKey: "home.skills",
    target: "skills",
  },
  {
    icon: PlayCircleOutlined,
    id: "workflows",
    labelKey: "sidebar.workflows",
    target: "workflows",
  },
  {
    icon: FolderOpenOutlined,
    id: "drive",
    labelKey: "sidebar.drive",
    target: "drive",
  },
  {
    icon: FileSearchOutlined,
    id: "runs",
    labelKey: "home.nav.runs",
    target: "runs",
  },
];

const SidebarSection = ({ caption, children, className = "", sectionRef, title }) => (
  <section
    className={`archive-sidebar-section ${className}`.trim()}
    ref={sectionRef}
  >
    <div className="archive-sidebar-section-head">
      <span className="archive-sidebar-section-title">{title}</span>
      {caption ? (
        <span className="archive-sidebar-section-caption">{caption}</span>
      ) : null}
    </div>
    {children}
  </section>
);

const SidebarMetric = ({ label, value }) => (
  <div className="archive-sidebar-stat">
    <span className="archive-meta-label">{label}</span>
    <span className="archive-meta-value">{value}</span>
  </div>
);

const RecoveryFactRow = ({ label, value }) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return (
    <div className="archive-recovery-fact-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
};

const RecoveryQueuePanel = ({
  isActionPending,
  isLoading,
  onRecoveryAction,
  runs = [],
  t = defaultT,
}) => {
  if (isLoading) {
    return (
      <div className="archive-recovery-empty">{t("sidebar.loadingRecovery")}</div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="archive-recovery-empty">
        {t("sidebar.noRecoveryRuns")}
      </div>
    );
  }

  return (
    <div className="archive-recovery-list">
      {runs.map((run) => {
        const actions = run.recovery?.actions ?? [];
        const retryAction = actions.find(
          (action) => action.type === "retry_failed_step"
        );
        // The card describes the step its Retry replays, else the step the
        // run stopped at: another failed step (a self-check, say) is not
        // what the button runs.
        const step = retryAction
          ? retryAction.safety
          : run.recovery?.replaySafety?.steps?.[0];
        const runStatus = formatStatusLabel(run.status, t);

        return (
          <div className="archive-recovery-item" key={run.runId}>
            <div className="archive-recovery-item-main">
              <span>{runStatus}</span>
              <strong>{run.goal ?? run.runId}</strong>
              <p>
                {run.recovery?.reason
                  ? formatStatusLabel(run.recovery.reason, t)
                  : t("sidebar.manualRecoveryRequired")}
              </p>
              <div className="archive-recovery-facts">
                <RecoveryFactRow label={t("sidebar.runStatus")} value={runStatus} />
                <RecoveryFactRow
                  label={t("sidebar.recoveryMode")}
                  value={
                    run.recovery?.requestedMode &&
                    formatStatusLabel(run.recovery.requestedMode, t)
                  }
                />
                {step ? (
                  <>
                    <RecoveryFactRow
                      label={t("sidebar.step")}
                      value={formatStepLabel(
                        { label: step.label, type: step.stepType },
                        t
                      )}
                    />
                    <RecoveryFactRow
                      label={t("sidebar.replay")}
                      value={(step.reasonCodes ?? [])
                        .map((code) => formatStatusLabel(code, t))
                        .join(", ")}
                    />
                  </>
                ) : null}
              </div>
            </div>
            <div className="archive-recovery-actions">
              {actions.map((action) => (
                <button
                  key={`${run.runId}-${action.type}-${action.stepId}`}
                  type="button"
                  className={
                    action.type === "cancel"
                      ? "archive-run-control-button"
                      : "archive-run-control-button is-primary"
                  }
                  disabled={Boolean(isActionPending)}
                  onClick={() =>
                    onRecoveryAction?.({
                      action: action.type,
                      runId: run.runId,
                      stepId: action.stepId,
                    })
                  }
                >
                  {formatRecoveryActionLabel(action.type, t)}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const WorkspaceSidebar = ({
  activeNavItem,
  activeDocuments,
  arxivSuggestion,
  authStatus = "disabled",
  canAdmin = true,
  canDelete = true,
  canUpload = true,
  conversationCount,
  documentListRef,
  isActionPending,
  isArxivImporting,
  isArxivSuggestionLoading,
  isQualityLoading,
  isRecoveryLoading,
  locale = "en",
  onClearDocuments,
  onDismissArxivSuggestion,
  onImportArxivSuggestion,
  onLoadQualityHistory,
  onLoadQualityLatest,
  onOpenSavedArxivSuggestion,
  onRecoveryAction,
  onRemoveDocument,
  onRequestArxivSuggestions,
  onRunSyntheticQuality,
  onToggleChatScopeDocument,
  onNavigate,
  onUploadSuccess,
  qualityHistory,
  qualityReport,
  qualityRef,
  recoveryRuns,
  savedArxivSuggestionsByDocId = {},
  selectedChatDocIds = [],
  t = defaultT,
  totalPages,
  uploadRef,
}) => (
  <aside className="archive-sidebar" aria-label={t("sidebar.workspaceControls")}>
    <div className="archive-sidebar-top">
      <div className="archive-sidebar-title-row">
        <div className="archive-sidebar-brand">
            <div className="archive-brand-mark">A</div>
            <div className="archive-sidebar-title-group">
            <div className="archive-sidebar-kicker">{t("sidebar.trustedWorkspace")}</div>
            <div className="archive-sidebar-title">Archive RAG</div>
          </div>
        </div>
      </div>

      <div className="archive-sidebar-action-row">
        <button type="button" onClick={() => void onNavigate?.("new-chat")}>
          <PlusCircleOutlined aria-hidden="true" />
          {t("sidebar.newChat")}
        </button>
        <button type="button" onClick={() => void onNavigate?.("search")}>
          <SearchOutlined aria-hidden="true" />
          {t("sidebar.search")}
        </button>
      </div>

      <nav className="archive-product-nav" aria-label={t("sidebar.workspaceNavigation")}>
        {WORKSPACE_NAV_ITEMS.map((item) => {
          const NavIcon = item.icon;

          return (
            <button
              key={item.id}
              type="button"
              className={activeNavItem === item.id ? "is-active" : ""}
              onClick={() => void onNavigate?.(item.target)}
            >
              <NavIcon aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>
    </div>

    <SidebarSection
      caption={t("sidebar.pagesCaption", {
        count: totalPages,
        documents: t("common.documentCount", { count: activeDocuments.length }),
      })}
      className="archive-upload-section"
      sectionRef={uploadRef}
      title={t("sidebar.corpus")}
    >
      <div className="archive-sidebar-stats">
        <SidebarMetric
          label={t("sidebar.sources")}
          value={t("common.documentCount", { count: activeDocuments.length })}
        />
        <SidebarMetric label={t("home.stat.pages")} value={totalPages} />
        <SidebarMetric label={t("sidebar.turns")} value={conversationCount} />
      </div>
      {canUpload ? (
        <PdfUploader onUploadSuccess={onUploadSuccess} t={t} />
      ) : (
        <p className="archive-permission-note" role="note">
          {t(authStatus === "signed_in" ? "auth.uploadNotAllowed" : "auth.signInRequired")}
        </p>
      )}
      <ArxivSuggestionPanel
        isImporting={isArxivImporting}
        isLoading={isArxivSuggestionLoading}
        onDismiss={onDismissArxivSuggestion}
        onImport={onImportArxivSuggestion}
        suggestion={arxivSuggestion}
        t={t}
      />
    </SidebarSection>

    <SidebarSection
      caption={t("common.documentCount", { count: activeDocuments.length })}
      className="archive-doc-section"
      sectionRef={documentListRef}
      title={t("sidebar.scope")}
    >

      {activeDocuments.length > 0 ? (
        <div className="document-list">
          {activeDocuments.map((document) => {
            const isInSelectedChatScope = selectedChatDocIds.includes(document.docId);
            const savedArxivSuggestion =
              !isArxivDocument(document)
                ? savedArxivSuggestionsByDocId[document.docId]
                : null;
            const savedArxivPaperCount =
              savedArxivSuggestion?.papers?.length ?? 0;
            const pageCount = formatPageCount(document.pageCount);

            return (
              <article
                key={document.docId}
                className={`document-item ${
                  isInSelectedChatScope ? "is-selected" : ""
                }`}
              >
                <button
                  type="button"
                  className={`document-item-main document-item-main-button ${
                    isInSelectedChatScope ? "is-selected" : ""
                  }`}
                  aria-pressed={isInSelectedChatScope}
                  onClick={() =>
                    onToggleChatScopeDocument?.(document.docId)
                  }
                >
                  <div className="document-item-title">{document.fileName}</div>
                  <div className="document-item-meta">
                    {/* A deck counts slides, a workbook sheets, a Word file
                        sections; a PDF (or an unknown type) keeps its pages. */}
                    {formatDocumentUnitCount(document, pageCount, t) ??
                      `${pageCount} ${t(pageCount === 1 ? "common.page" : "common.pages")}`}
                    {document.version ? ` · ${document.version}` : ""}
                    {` · ID ${document.docId.slice(0, 8)}`}
                  </div>
                  <div className="document-source-row">
                    <span
                      className={`document-source-badge ${
                        isArxivDocument(document) ? "is-arxiv" : "is-uploaded"
                      }`}
                    >
                      {getDocumentSourceLabel(document, t)}
                    </span>
                  </div>
                  <DocumentProfileSnippet document={document} />
                </button>

                {savedArxivPaperCount > 0 ? (
                  <button
                    type="button"
                    className="document-arxiv-recommendation-button"
                    aria-label={t("sidebar.reviewSavedArxiv", {
                      fileName: document.fileName,
                    })}
                    onClick={() =>
                      void onOpenSavedArxivSuggestion?.(document.docId)
                    }
                  >
                    <FileSearchOutlined />
                    <span>
                      {t("sidebar.arxivRecommendations", {
                        count: savedArxivPaperCount,
                      })}
                    </span>
                  </button>
                ) : null}

                {/* Only this click sends a document's topic to arXiv; one
                    search at a time, since the panel shows one result.
                    Uploaders only: a read-only role could never import. */}
                {canUpload && !isArxivDocument(document) ? (
                  <button
                    type="button"
                    className="document-arxiv-recommendation-button"
                    aria-label={t("sidebar.findRelatedArxivFor", {
                      fileName: document.fileName,
                    })}
                    disabled={Boolean(isArxivSuggestionLoading)}
                    onClick={() => void onRequestArxivSuggestions?.(document)}
                  >
                    <SearchOutlined />
                    <span>{t("sidebar.findRelatedArxiv")}</span>
                  </button>
                ) : null}

                <div className="document-item-actions">
                  <button
                    type="button"
                    className={`document-scope-toggle ${
                      isInSelectedChatScope ? "is-active" : ""
                    }`}
                    aria-label={t(
                      isInSelectedChatScope
                        ? "sidebar.excludeFromScope"
                        : "sidebar.includeInScope",
                      {
                        fileName: document.fileName,
                      }
                    )}
                    aria-pressed={isInSelectedChatScope}
                    onClick={() => void onToggleChatScopeDocument?.(document.docId)}
                  >
                    {isInSelectedChatScope ? <CheckSquareOutlined /> : <PlusCircleOutlined />}
                  </button>
                  {/* The server deletes at once (no trash by default) and
                      the workbench then resets the conversation, so a
                      click only asks. */}
                  <Popconfirm
                    title={t("sidebar.removeDocumentConfirm", {
                      fileName: document.fileName,
                    })}
                    description={t("sidebar.deleteCannotBeUndone")}
                    okText={t("sidebar.confirmDelete")}
                    cancelText={t("common.cancel")}
                    okButtonProps={{ danger: true }}
                    disabled={!canDelete}
                    onConfirm={() => onRemoveDocument(document.docId)}
                  >
                    <button
                      type="button"
                      className="document-item-remove"
                      aria-label={t("sidebar.removeDocument", {
                        fileName: document.fileName,
                      })}
                      disabled={!canDelete}
                      title={canDelete ? undefined : t("auth.deleteNotAllowed")}
                    >
                      ×
                    </button>
                  </Popconfirm>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="archive-empty-state">
          <div className="archive-empty-mark">{t("sidebar.emptyDocumentsTitle")}</div>
          <div>{t("sidebar.emptyDocumentsHint")}</div>
        </div>
      )}
    </SidebarSection>

    <SidebarSection
      caption={t("sidebar.qualityCaption")}
      className="archive-quality-section"
      sectionRef={qualityRef}
      title={t("sidebar.quality")}
    >
      <QualityGuardPanel
        isQualityLoading={isQualityLoading}
        onLoadHistory={onLoadQualityHistory}
        onLoadLatest={onLoadQualityLatest}
        onRunSynthetic={onRunSyntheticQuality}
        canRunSynthetic={canAdmin}
        locale={locale}
        qualityHistory={qualityHistory}
        qualityReport={qualityReport}
        t={t}
      />
    </SidebarSection>

    <SidebarSection
      caption={t("sidebar.recoveryWaiting", {
        count: recoveryRuns?.length ?? 0,
      })}
      className="archive-recovery-panel"
      title={t("sidebar.recovery")}
    >
      <RecoveryQueuePanel
        isActionPending={isActionPending}
        isLoading={isRecoveryLoading}
        onRecoveryAction={onRecoveryAction}
        runs={recoveryRuns}
        t={t}
      />
    </SidebarSection>

    <section className="archive-sidebar-footer">
      <Popconfirm
        title={t("sidebar.clearWorkspaceConfirm", {
          count: activeDocuments.length,
        })}
        description={t("sidebar.deleteCannotBeUndone")}
        okText={t("sidebar.confirmDelete")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
        disabled={activeDocuments.length === 0 || !canDelete}
        onConfirm={() => onClearDocuments()}
      >
        <Button
          className="archive-secondary-button archive-sidebar-clear"
          disabled={activeDocuments.length === 0 || !canDelete}
          title={canDelete ? undefined : t("auth.deleteNotAllowed")}
        >
          {t("sidebar.clearWorkspace")}
        </Button>
      </Popconfirm>
    </section>
  </aside>
);

export default memo(WorkspaceSidebar);
