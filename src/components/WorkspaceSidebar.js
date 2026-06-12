import { Button } from "antd";
import {
  AppstoreOutlined,
  CheckSquareOutlined,
  DatabaseOutlined,
  PlusCircleOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  buildPreviewSourceFromDocument,
  formatDocumentCount,
  formatPageCount,
  getDocumentSource,
  isArxivDocument,
} from "../archiveWorkspace";
import DocumentProfileSnippet from "./DocumentProfileSnippet";
import ArxivSuggestionPanel from "./ArxivSuggestionPanel";
import PdfUploader from "./PdfUploader";
import QualityGuardPanel from "./QualityGuardPanel";
import SpotlightCard from "./react-bits/SpotlightCard";

const getDocumentSourceLabel = (document) => {
  const source = getDocumentSource(document);

  if (isArxivDocument(document)) {
    return source?.arxivId ? `arXiv ${source.arxivId}` : "arXiv";
  }

  return "Uploaded";
};

const WorkspaceSidebar = ({
  activeNavTarget,
  activeDocuments,
  arxivSuggestion,
  conversationCount,
  currentTurn,
  documentListRef,
  isArxivImporting,
  isArxivSuggestionLoading,
  isDemoWorkbench,
  isQualityLoading,
  onClearDocuments,
  onDismissArxivSuggestion,
  onImportArxivSuggestion,
  onLoadQualityHistory,
  onLoadQualityLatest,
  onRemoveDocument,
  onRunSyntheticQuality,
  onSelectSource,
  onToggleChatScopeDocument,
  onNavigate,
  onUploadSuccess,
  qualityHistory,
  qualityReport,
  qualityRef,
  relevantDocuments,
  selectedChatDocIds = [],
  selectedDocId,
  totalPages,
  uploadRef,
  workspaceDocumentTotal,
}) => (
  <aside className="archive-sidebar">
    <div className="archive-sidebar-top">
      <div className="archive-sidebar-title-row">
        <div className="archive-sidebar-brand">
          <div className="archive-brand-mark">A</div>
          <div className="archive-sidebar-title-group">
            <div className="archive-sidebar-kicker">Workspace</div>
            <div className="archive-sidebar-title">Archive RAG</div>
          </div>
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

    <nav className="archive-sidebar-nav" aria-label="Primary">
      <button
        type="button"
        aria-label="New chat"
        className={activeNavTarget === "new-chat" ? "is-active" : ""}
        onClick={() => void onNavigate?.("new-chat")}
      >
        <PlusCircleOutlined />
        New chat
        <span>+</span>
      </button>
      <button
        type="button"
        aria-label="Search"
        className={activeNavTarget === "search" ? "is-active" : ""}
        onClick={() => void onNavigate?.("search")}
      >
        <SearchOutlined />
        Search
        <span>⌘K</span>
      </button>
      <button
        type="button"
        aria-label="Workspaces"
        className={activeNavTarget === "workspaces" ? "is-active" : ""}
        onClick={() => void onNavigate?.("workspaces")}
      >
        <AppstoreOutlined />
        Workspaces
      </button>
      <button
        type="button"
        aria-label="Datasets"
        className={activeNavTarget === "datasets" ? "is-active" : ""}
        onClick={() => void onNavigate?.("datasets")}
      >
        <DatabaseOutlined />
        Datasets
      </button>
      <button
        type="button"
        aria-label="Agents"
        className={activeNavTarget === "agents" ? "is-active" : ""}
        onClick={() => void onNavigate?.("agents")}
      >
        <RobotOutlined />
        Agents
      </button>
      <button
        type="button"
        aria-label="Evaluations"
        className={activeNavTarget === "evaluations" ? "is-active" : ""}
        onClick={() => void onNavigate?.("evaluations")}
      >
        <CheckSquareOutlined />
        Evaluations
      </button>
      <button
        type="button"
        aria-label="Settings"
        className={activeNavTarget === "settings" ? "is-active" : ""}
        onClick={() => void onNavigate?.("settings")}
      >
        <SettingOutlined />
        Settings
      </button>
    </nav>

    <section className="archive-sidebar-section archive-upload-section" ref={uploadRef}>
      <div className="archive-sidebar-section-head">
        <span className="archive-sidebar-section-title">Ingest</span>
        <span className="archive-sidebar-section-caption">
          Upload documents
        </span>
      </div>
      <PdfUploader onUploadSuccess={onUploadSuccess} />
      <ArxivSuggestionPanel
        isImporting={isArxivImporting}
        isLoading={isArxivSuggestionLoading}
        onDismiss={onDismissArxivSuggestion}
        onImport={onImportArxivSuggestion}
        suggestion={arxivSuggestion}
      />
    </section>

    <section className="archive-sidebar-section archive-context-section">
      <div className="archive-sidebar-section-head">
        <span className="archive-sidebar-section-title">Relevant documents</span>
        <span className="archive-sidebar-section-caption">
          {currentTurn
            ? "Files referenced in the active answer"
            : "Ask a question to surface related files"}
        </span>
      </div>

      {relevantDocuments.length > 0 ? (
        <div className="relevant-document-list">
          {relevantDocuments.map((document) => (
            <SpotlightCard
              as="button"
              key={document.docId}
              type="button"
              className={`relevant-document-item ${
                selectedDocId === document.docId ? "is-selected" : ""
              }`}
              aria-pressed={selectedDocId === document.docId}
              onClick={() => onSelectSource(document.previewSource)}
              spotlightColor="rgba(15, 159, 122, 0.1)"
            >
              <div className="relevant-document-title">{document.fileName}</div>
              <div className="relevant-document-meta">
                {document.pages.length > 0
                  ? `Pages ${document.pages.join(", ")}`
                  : "Page 1"}
              </div>
              <DocumentProfileSnippet document={document} compact />
            </SpotlightCard>
          ))}
        </div>
      ) : (
        <div className="archive-empty-state archive-empty-state-compact">
          <div className="archive-empty-mark">No relevant documents yet</div>
          <div>The current answer has not cited any pages yet.</div>
        </div>
      )}
    </section>

    <section className="archive-sidebar-section archive-doc-section" ref={documentListRef}>
      <div className="archive-sidebar-section-head">
        <span className="archive-sidebar-section-title">Workspace documents</span>
        <span className="archive-sidebar-section-caption">
          {formatDocumentCount(workspaceDocumentTotal ?? activeDocuments.length)}
        </span>
      </div>

      {activeDocuments.length > 0 ? (
        <div className="document-list">
          {activeDocuments.map((document) => {
            const isInSelectedChatScope = selectedChatDocIds.includes(document.docId);

            return (
              <SpotlightCard
                as="article"
                key={document.docId}
                className={`document-item ${
                  selectedDocId === document.docId ? "is-selected" : ""
                }`}
                spotlightColor="rgba(39, 110, 241, 0.09)"
              >
                <button
                  type="button"
                  className={`document-item-main document-item-main-button ${
                    selectedDocId === document.docId ? "is-selected" : ""
                  }`}
                  aria-pressed={selectedDocId === document.docId}
                  onClick={() =>
                    onSelectSource(
                      document.previewSource ?? buildPreviewSourceFromDocument(document)
                    )
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
              </SpotlightCard>
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
    </section>

    <section className="archive-sidebar-section archive-quality-section" ref={qualityRef}>
      <div className="archive-sidebar-section-head">
        <span className="archive-sidebar-section-title">Quality Guard</span>
        <span className="archive-sidebar-section-caption">
          Synthetic RAG checks and failure hints
        </span>
      </div>
      <QualityGuardPanel
        isQualityLoading={isQualityLoading}
        onLoadHistory={onLoadQualityHistory}
        onLoadLatest={onLoadQualityLatest}
        onRunSynthetic={onRunSyntheticQuality}
        qualityHistory={qualityHistory}
        qualityReport={qualityReport}
      />
    </section>

    <section className="archive-sidebar-footer">
      <div className="archive-sidebar-stats">
        <div className="archive-sidebar-stat">
          <span className="archive-meta-label">Responses</span>
          <span className="archive-meta-value">{conversationCount}</span>
        </div>
        <div className="archive-sidebar-stat">
          <span className="archive-meta-label">Pages</span>
          <span className="archive-meta-value">{totalPages}</span>
        </div>
      </div>

      <Button
        className="archive-secondary-button archive-sidebar-clear"
        onClick={() => void onClearDocuments()}
        disabled={activeDocuments.length === 0}
      >
        Clear workspace
      </Button>

      <div className="archive-enterprise-card">
        <UploadOutlined />
        <span>Archive RAG Enterprise</span>
        <span>›</span>
      </div>
    </section>
  </aside>
);

export default WorkspaceSidebar;
