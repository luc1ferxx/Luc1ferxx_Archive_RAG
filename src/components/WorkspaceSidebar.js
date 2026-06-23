import { Button } from "antd";
import {
  CheckSquareOutlined,
  FileSearchOutlined,
  PlusCircleOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  formatDocumentCount,
  formatPageCount,
  getDocumentSource,
  isArxivDocument,
} from "../archiveWorkspace";
import DocumentProfileSnippet from "./DocumentProfileSnippet";
import ArxivSuggestionPanel from "./ArxivSuggestionPanel";
import PdfUploader from "./PdfUploader";
import QualityGuardPanel from "./QualityGuardPanel";
import {
  formatRecoveryActionLabel,
  formatReplaySafetyCodeLine,
  formatReplaySafetyDecision,
  formatReplaySafetyReasonCodes,
  formatTaskStatus,
  getRecoveryReplaySafetyItems,
} from "./workbenchFormatters";

const getDocumentSourceLabel = (document) => {
  const source = getDocumentSource(document);

  if (isArxivDocument(document)) {
    return source?.arxivId ? `arXiv ${source.arxivId}` : "arXiv";
  }

  return "Uploaded";
};

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

const ReplaySafetyItem = ({ safety }) => {
  const reasonText = formatReplaySafetyReasonCodes(safety);
  const reasonDetails = Array.isArray(safety.reasons) ? safety.reasons : [];

  return (
    <div className="archive-recovery-safety-item">
      <div className="archive-recovery-safety-head">
        <span>{safety.stepType ?? "step"}</span>
        <strong>{formatReplaySafetyDecision(safety)}</strong>
      </div>
      <p>{reasonText}</p>
      {safety.summary ? <p>{safety.summary}</p> : null}
      {reasonDetails.length > 0 ? (
        <div className="archive-recovery-reason-list">
          {reasonDetails.map((reason) => (
            <span key={reason.code ?? reason.label}>
              {reason.label ?? reason.code}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const RecoveryActionSafety = ({ action }) => {
  if (!action?.safety) {
    return null;
  }

  return (
    <div className="archive-recovery-action-safety">
      <span>{formatRecoveryActionLabel(action.type)}</span>
      <strong>{formatReplaySafetyCodeLine(action.safety)}</strong>
    </div>
  );
};

const RecoveryQueuePanel = ({
  isActionPending,
  isLoading,
  onRecoveryAction,
  runs = [],
}) => {
  if (isLoading) {
    return (
      <div className="archive-recovery-empty">Loading recovery queue.</div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="archive-recovery-empty">
        No agent runs are waiting for recovery.
      </div>
    );
  }

  return (
    <div className="archive-recovery-list">
      {runs.map((run) => {
        const replaySafetyItems = getRecoveryReplaySafetyItems(run.recovery);
        const replaySafety = run.recovery?.replaySafety ?? {};
        const runStatus = formatTaskStatus(run.status);

        return (
          <div className="archive-recovery-item" key={run.runId}>
            <div className="archive-recovery-item-main">
              <span>{runStatus}</span>
              <strong>{run.goal ?? run.runId}</strong>
              <p>{run.recovery?.reason ?? "Manual recovery required."}</p>
              <div className="archive-recovery-facts">
                <RecoveryFactRow label="Run status" value={runStatus} />
                <RecoveryFactRow
                  label="Recovery mode"
                  value={run.recovery?.requestedMode}
                />
                <RecoveryFactRow label="Step" value={run.recovery?.stepId} />
                <RecoveryFactRow
                  label="Replay"
                  value={formatReplaySafetyDecision(replaySafety)}
                />
              </div>
              {replaySafetyItems.length > 0 ? (
                <div className="archive-recovery-safety-list">
                  {replaySafetyItems.map((safety) => (
                    <ReplaySafetyItem
                      key={
                        safety.stepId ??
                        `${safety.stepType}-${formatReplaySafetyCodeLine(safety)}`
                      }
                      safety={safety}
                    />
                  ))}
                </div>
              ) : null}
              {(run.recovery?.actions ?? []).some((action) => action.safety) ? (
                <div className="archive-recovery-action-safety-list">
                  {(run.recovery?.actions ?? []).map((action) => (
                    <RecoveryActionSafety
                      action={action}
                      key={`${run.runId}-${action.type}-${action.stepId ?? ""}-safety`}
                    />
                  ))}
                </div>
              ) : null}
            </div>
            <div className="archive-recovery-actions">
              {(run.recovery?.actions ?? []).map((action) => (
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
                  {formatRecoveryActionLabel(action.type)}
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
  activeDocuments,
  arxivSuggestion,
  conversationCount,
  documentListRef,
  isActionPending,
  isArxivImporting,
  isArxivSuggestionLoading,
  isDemoWorkbench,
  isQualityLoading,
  isRecoveryLoading,
  onClearDocuments,
  onDismissArxivSuggestion,
  onImportArxivSuggestion,
  onLoadQualityHistory,
  onLoadQualityLatest,
  onOpenSavedArxivSuggestion,
  onRecoveryAction,
  onRemoveDocument,
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
  totalPages,
  uploadRef,
  workspaceDocumentTotal,
}) => (
  <aside className="archive-sidebar" aria-label="Workspace controls">
    <div className="archive-sidebar-top">
      <div className="archive-sidebar-title-row">
        <div className="archive-sidebar-brand">
          <div className="archive-brand-mark">A</div>
          <div className="archive-sidebar-title-group">
            <div className="archive-sidebar-kicker">Trusted workspace</div>
            <div className="archive-sidebar-title">Archive RAG</div>
          </div>
        </div>
      </div>

      <div className="archive-sidebar-action-row">
        <button type="button" onClick={() => void onNavigate?.("new-chat")}>
          <PlusCircleOutlined />
          New chat
        </button>
        <button type="button" onClick={() => void onNavigate?.("search")}>
          <SearchOutlined />
          Search
        </button>
      </div>
    </div>

    <SidebarSection
      caption={`${formatDocumentCount(activeDocuments.length)} · ${totalPages} pages`}
      className="archive-upload-section"
      sectionRef={uploadRef}
      title="Corpus"
    >
      <div className="archive-sidebar-stats">
        <SidebarMetric
          label="Sources"
          value={formatDocumentCount(activeDocuments.length)}
        />
        <SidebarMetric label="Pages" value={totalPages} />
        <SidebarMetric label="Turns" value={conversationCount} />
      </div>
      <PdfUploader onUploadSuccess={onUploadSuccess} />
      <ArxivSuggestionPanel
        isImporting={isArxivImporting}
        isLoading={isArxivSuggestionLoading}
        onDismiss={onDismissArxivSuggestion}
        onImport={onImportArxivSuggestion}
        suggestion={arxivSuggestion}
      />
    </SidebarSection>

    <SidebarSection
      caption={formatDocumentCount(workspaceDocumentTotal ?? activeDocuments.length)}
      className="archive-doc-section"
      sectionRef={documentListRef}
      title="Scope"
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
                    {formatPageCount(document.pageCount)} pages
                    {document.version ? ` · ${document.version}` : ""}
                    {document.age ? ` · ${document.age}` : ` · ID ${document.docId.slice(0, 8)}`}
                  </div>
                  <div className="document-source-row">
                    <span
                      className={`document-source-badge ${
                        isArxivDocument(document) ? "is-arxiv" : "is-uploaded"
                      }`}
                    >
                      {getDocumentSourceLabel(document)}
                    </span>
                  </div>
                  <DocumentProfileSnippet document={document} />
                </button>

                {savedArxivPaperCount > 0 ? (
                  <button
                    type="button"
                    className="document-arxiv-recommendation-button"
                    aria-label={`Review saved arXiv recommendations for ${document.fileName}`}
                    onClick={() =>
                      void onOpenSavedArxivSuggestion?.(document.docId)
                    }
                  >
                    <FileSearchOutlined />
                    <span>{savedArxivPaperCount} arXiv recommendations</span>
                  </button>
                ) : null}

                {isDemoWorkbench ? (
                  <span className={`document-status-dot is-${document.status ?? "ready"}`} />
                ) : (
                  <div className="document-item-actions">
                    <button
                      type="button"
                      className={`document-scope-toggle ${
                        isInSelectedChatScope ? "is-active" : ""
                      }`}
                      aria-label={`${
                        isInSelectedChatScope ? "Exclude" : "Include"
                      } ${document.fileName} in selected chat scope`}
                      aria-pressed={isInSelectedChatScope}
                      onClick={() => void onToggleChatScopeDocument?.(document.docId)}
                    >
                      {isInSelectedChatScope ? <CheckSquareOutlined /> : <PlusCircleOutlined />}
                    </button>
                    <button
                      type="button"
                      className="document-item-remove"
                      aria-label={`Remove ${document.fileName}`}
                      onClick={() => void onRemoveDocument(document.docId)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </article>
            );
          })}
          {isDemoWorkbench ? (
            <button
              type="button"
              className="archive-show-more-button"
              onClick={() => void onNavigate?.("datasets")}
            >
              Show 19 more
            </button>
          ) : null}
        </div>
      ) : (
        <div className="archive-empty-state">
          <div className="archive-empty-mark">No documents yet</div>
          <div>Upload at least one PDF to start asking questions.</div>
        </div>
      )}
    </SidebarSection>

    <SidebarSection
      caption="Synthetic RAG checks and failure hints"
      className="archive-quality-section"
      sectionRef={qualityRef}
      title="Quality"
    >
      <QualityGuardPanel
        isQualityLoading={isQualityLoading}
        onLoadHistory={onLoadQualityHistory}
        onLoadLatest={onLoadQualityLatest}
        onRunSynthetic={onRunSyntheticQuality}
        qualityHistory={qualityHistory}
        qualityReport={qualityReport}
      />
    </SidebarSection>

    <SidebarSection
      caption={`${recoveryRuns?.length ?? 0} waiting`}
      className="archive-recovery-panel"
      title="Recovery"
    >
      <RecoveryQueuePanel
        isActionPending={isActionPending}
        isLoading={isRecoveryLoading}
        onRecoveryAction={onRecoveryAction}
        runs={recoveryRuns}
      />
    </SidebarSection>

    <section className="archive-sidebar-footer">
      <Button
        className="archive-secondary-button archive-sidebar-clear"
        onClick={() => void onClearDocuments()}
        disabled={activeDocuments.length === 0}
      >
        Clear workspace
      </Button>
    </section>
  </aside>
);

export default WorkspaceSidebar;
