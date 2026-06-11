import { Button } from "antd";
import {
  buildPreviewSourceFromDocument,
  formatDocumentCount,
  formatPageCount,
} from "../archiveWorkspace";
import DocumentProfileSnippet from "./DocumentProfileSnippet";
import PdfUploader from "./PdfUploader";
import QualityGuardPanel from "./QualityGuardPanel";

const WorkspaceSidebar = ({
  activeDocuments,
  conversationCount,
  currentTurn,
  isQualityLoading,
  onClearDocuments,
  onLoadQualityHistory,
  onLoadQualityLatest,
  onRemoveDocument,
  onRunSyntheticQuality,
  onSelectSource,
  onUploadSuccess,
  qualityHistory,
  qualityReport,
  relevantDocuments,
  selectedDocId,
  totalPages,
}) => (
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
      <PdfUploader onUploadSuccess={onUploadSuccess} />
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
            <button
              key={document.docId}
              type="button"
              className={`relevant-document-item ${
                selectedDocId === document.docId ? "is-selected" : ""
              }`}
              aria-pressed={selectedDocId === document.docId}
              onClick={() => onSelectSource(document.previewSource)}
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
        <span className="archive-sidebar-section-title">Workspace documents</span>
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
                onClick={() => onSelectSource(buildPreviewSourceFromDocument(document))}
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
                onClick={() => void onRemoveDocument(document.docId)}
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
    </section>
  </aside>
);

export default WorkspaceSidebar;
