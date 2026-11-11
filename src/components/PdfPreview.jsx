import React, { useEffect, useMemo, useState } from "react";
import { Button, Input } from "antd";
import {
  BookOutlined,
  DownloadOutlined,
  ExpandOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { createTranslator } from "../archiveI18n";
import { formatDocumentLocation } from "../documentLocation";
import {
  useAuthenticatedDocumentDownload,
  useAuthenticatedDocumentPreview,
} from "../hooks/useAuthenticatedDocumentPreview";
import { buildSourceEvidenceObject } from "./evidenceSpine";

// English unless the app hands in its translator, so the preview reads as it
// always did wherever no locale is wired.
const defaultT = createTranslator("en");

const formatTabLabel = (singular, plural, count) =>
  count > 1 ? `${plural} ${count}` : singular;

// The cited text itself, never a demo description: the evidence panel of a
// file without an inline preview shows only what the answer cited.
const getCitedText = (source = {}) =>
  String(source.excerpt ?? source.text ?? source.pageContent ?? "").trim();

const getPreviewTabs = (evidence, t) => [
  {
    id: "preview",
    label: evidence.hasInlinePreview ? "Page" : t("preview.fileTab"),
  },
  {
    id: "chunks",
    label: formatTabLabel("Chunk", "Chunks", evidence.chunks.length),
  },
  { id: "metadata", label: "Metadata" },
  {
    id: "citations",
    label: formatTabLabel("Citation", "Citations", evidence.citations.length),
  },
];

const getObjectTags = (evidence) =>
  evidence.previewTags.length > 0
    ? evidence.previewTags
    : [
        Number.isFinite(evidence.rank) ? `rank ${evidence.rank}` : null,
        Number.isFinite(evidence.chunkIndex) ? `chunk ${evidence.chunkIndex}` : null,
        evidence.score ? `score ${evidence.score}` : null,
      ].filter(Boolean);

const getChunkLabel = (chunk, index) => {
  if (typeof chunk === "string") {
    return `Chunk ${index + 1}`;
  }

  return chunk.label ?? (Number.isFinite(chunk.chunkIndex) ? `Chunk ${chunk.chunkIndex}` : `Chunk ${index + 1}`);
};

const getChunkExcerpt = (chunk) =>
  typeof chunk === "string"
    ? chunk
    : chunk.excerpt ?? chunk.text ?? chunk.pageContent ?? "";

const getCitationTitle = (citation, index, fallbackFileName) =>
  citation.fileName ?? citation.title ?? fallbackFileName ?? `Citation ${index + 1}`;

const getCitationMeta = (citation, t) =>
  [
    formatDocumentLocation(citation, t) || null,
    Number.isFinite(citation.rank) ? `Rank #${citation.rank}` : null,
    Number.isFinite(citation.chunkIndex) ? `Chunk ${citation.chunkIndex}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

const PdfPreview = ({ source, t = defaultT }) => {
  const [activeTab, setActiveTab] = useState("preview");
  const [displayPage, setDisplayPage] = useState(source?.pageNumber ?? 1);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [zoom, setZoom] = useState(100);

  const evidence = useMemo(
    () => (source ? buildSourceEvidenceObject(source, { t }) : null),
    [source, t]
  );
  const previewTabs = useMemo(
    () => (evidence ? getPreviewTabs(evidence, t) : []),
    [evidence, t]
  );
  // Only a PDF (or a source of unknown type, as before the Office formats)
  // is fetched for the inline viewer. A Word, PowerPoint or Excel file is
  // fetched only when the user asks to download it.
  const hasInlinePreview = evidence?.hasInlinePreview ?? true;
  const hasProtectedFile = Boolean(evidence?.filePath && !source?.demoPreview);
  const hasProtectedPdf = hasInlinePreview && hasProtectedFile;
  const hasDocumentId = Boolean(String(source?.docId ?? "").trim());
  const canLoadProtectedPdf = Boolean(hasProtectedPdf && hasDocumentId);
  const canDownloadFile = Boolean(
    !hasInlinePreview && hasProtectedFile && hasDocumentId
  );
  const authenticatedPreview = useAuthenticatedDocumentPreview({
    docId: source?.docId,
    enabled: canLoadProtectedPdf,
  });
  const documentDownload = useAuthenticatedDocumentDownload({
    docId: canDownloadFile ? source?.docId : "",
    fileName: source?.fileName,
  });

  useEffect(() => {
    setActiveTab("preview");
    setDisplayPage(source?.pageNumber ?? 1);
    setIsSearchOpen(false);
    setIsExpanded(false);
    setSearchQuery("");
    setZoom(100);
  }, [source?.docId, source?.chunkIndex, source?.pageNumber]);

  if (!source || !evidence) {
    return (
      <div className="archive-preview-empty">
        <div className="archive-preview-empty-mark">No source selected</div>
        <div>Choose a citation to preview the related page.</div>
      </div>
    );
  }

  const pageNumber = displayPage;
  const pageLabel = formatDocumentLocation({ pageNumber }, t);
  const previewUrl = authenticatedPreview.objectUrl
    ? `${authenticatedPreview.objectUrl}#page=${pageNumber}&view=FitH`
    : null;
  const isDownloading = documentDownload.status === "downloading";

  const updatePage = (delta) => {
    setDisplayPage((currentPage) => Math.max(1, currentPage + delta));
  };

  const updateZoom = (delta) => {
    setZoom((currentZoom) => Math.min(140, Math.max(80, currentZoom + delta)));
  };

  const renderEvidenceObject = () => {
    const tags = getObjectTags(evidence);

    return (
      <div className="archive-preview-evidence-object">
        <div className="archive-pdf-badge">{evidence.fileType}</div>
        <div className="archive-preview-object-main">
          <span>Evidence object</span>
          <strong>{evidence.fileName}</strong>
          <p>{evidence.previewDescription}</p>
          {tags.length > 0 ? (
            <div className="archive-preview-tags">
              {tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="archive-preview-object-facts">
          {evidence.metadataRows.slice(1, 5).map((row) => (
            <div key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderDemoPage = () => (
    <div className="archive-demo-pdf-page">
      <div
        className="archive-demo-pdf-content"
        style={{ transform: `scale(${zoom / 100})` }}
      >
        <h2>6.0 Travel and Entertainment</h2>
        <h3>6.1 International Travel</h3>
        <p>
          All international travel must be pre-approved by the employee's
          department head and booked through the corporate travel program.
        </p>
        <ul>
          <li>Economy class is required for flights under 8 hours.</li>
          <li>Business class requires VP approval.</li>
          <li>Non-refundable tickets are discouraged unless necessary.</li>
          <li>Travel insurance is required for all international trips.</li>
        </ul>

        <h3>6.2 Per Diem Limits</h3>
        <p>
          Daily per diem limits are based on location cost tier as defined
          below. Limits are inclusive of meals and incidental expenses.
        </p>
        <table>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Location Examples</th>
              <th>Total Per Diem (USD)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Tier 1</td>
              <td>Switzerland, Norway, Japan</td>
              <td>$320</td>
            </tr>
            <tr>
              <td>Tier 2</td>
              <td>Germany, France, UAE</td>
              <td>$260</td>
            </tr>
            <tr>
              <td>Tier 3</td>
              <td>India, Mexico, Brazil</td>
              <td>$180</td>
            </tr>
          </tbody>
        </table>

        <h3>6.3 Expense Rules</h3>
        <ul>
          <li>Receipts are required for expenses over $75.</li>
          <li>Alcohol is not reimbursable.</li>
          <li>Personal expenses must not be charged to corporate accounts.</li>
        </ul>
      </div>
    </div>
  );

  // A Word, PowerPoint or Excel file: the browser has no viewer for it, so
  // the panel names the file and where the citation points, offers the
  // authenticated download, and shows the cited text when there is one.
  const renderDownloadPanel = () => {
    const citedText = getCitedText(source);

    return (
      <div className="archive-preview-summary-page archive-preview-download-page">
        <div className="archive-preview-summary-mark">{evidence.fileType}</div>
        <strong>{evidence.fileName}</strong>
        {evidence.locationText ? (
          <span className="archive-preview-location">{evidence.locationText}</span>
        ) : null}
        <p>{t("preview.noInlinePreview")}</p>
        {canDownloadFile ? (
          <Button
            className="archive-secondary-button archive-preview-download-button"
            icon={<DownloadOutlined />}
            loading={isDownloading}
            onClick={() => void documentDownload.download()}
          >
            {isDownloading ? t("preview.downloading") : t("preview.download")}
          </Button>
        ) : null}
        {hasProtectedFile && !hasDocumentId ? (
          <p className="archive-preview-download-error" role="alert">
            {t("preview.downloadMissingDocument")}
          </p>
        ) : null}
        {canDownloadFile && documentDownload.status === "error" ? (
          <p className="archive-preview-download-error" role="alert">
            {documentDownload.errorMessage || t("preview.downloadFailed")}
          </p>
        ) : null}
        {citedText ? (
          <figure className="archive-preview-cited-evidence">
            <figcaption>{t("preview.citedEvidence")}</figcaption>
            <blockquote>{citedText}</blockquote>
          </figure>
        ) : null}
      </div>
    );
  };

  const renderPagePanel = () => {
    if (source.demoPreview) {
      return renderDemoPage();
    }

    if (!hasInlinePreview) {
      return renderDownloadPanel();
    }

    if (hasProtectedPdf && !hasDocumentId) {
      return (
        <div className="archive-preview-summary-page" role="alert">
          <div className="archive-preview-summary-mark">{evidence.fileType}</div>
          <strong>Preview unavailable</strong>
          <p>The selected source does not identify its document.</p>
        </div>
      );
    }

    if (
      canLoadProtectedPdf &&
      (authenticatedPreview.status === "idle" ||
        authenticatedPreview.status === "loading")
    ) {
      return (
        <div className="archive-preview-summary-page" aria-live="polite">
          <div className="archive-preview-summary-mark">{evidence.fileType}</div>
          <strong>Loading secure preview…</strong>
          <p>Fetching the selected document with your current access scope.</p>
        </div>
      );
    }

    if (canLoadProtectedPdf && authenticatedPreview.status === "error") {
      return (
        <div className="archive-preview-summary-page" role="alert">
          <div className="archive-preview-summary-mark">{evidence.fileType}</div>
          <strong>Preview unavailable</strong>
          <p>The document could not be loaded or was not a valid PDF.</p>
        </div>
      );
    }

    if (previewUrl) {
      return (
        <iframe
          className="archive-preview-frame"
          src={previewUrl}
          title={`${evidence.fileName} preview`}
          referrerPolicy="no-referrer"
        />
      );
    }

    return (
      <div className="archive-preview-summary-page">
        <div className="archive-preview-summary-mark">{evidence.fileType}</div>
        <strong>{evidence.fileName}</strong>
        <span>{pageLabel}</span>
        <p>{evidence.excerpt || evidence.previewDescription}</p>
      </div>
    );
  };

  const renderMetadataPanel = () => (
    <div className="archive-preview-info-card">
      {evidence.metadataRows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
      <p>{evidence.previewDescription}</p>
    </div>
  );

  const renderChunkPanel = () => (
    <div className="archive-preview-tab-panel">
      {evidence.chunks.map((chunk, index) => (
        <div key={chunk.id ?? `${getChunkLabel(chunk, index)}-${index}`} className="archive-preview-chunk">
          <span>{getChunkLabel(chunk, index)}</span>
          <p>{getChunkExcerpt(chunk)}</p>
        </div>
      ))}
    </div>
  );

  const renderCitationPanel = () => (
    <div className="archive-preview-tab-panel">
      {evidence.citations.map((citation, index) => (
        <div
          key={`${citation.docId ?? evidence.fileName}-${citation.chunkIndex ?? index}`}
          className="archive-preview-citation"
        >
          <span>{index === 0 ? "Selected citation" : `Citation ${index + 1}`}</span>
          <strong>{getCitationTitle(citation, index, evidence.fileName)}</strong>
          {getCitationMeta(citation, t) ? <p>{getCitationMeta(citation, t)}</p> : null}
          {citation.excerpt || citation.text ? (
            <p>{citation.excerpt ?? citation.text}</p>
          ) : null}
        </div>
      ))}
    </div>
  );

  const renderActiveTab = () => {
    if (activeTab === "metadata") {
      return renderMetadataPanel();
    }

    if (activeTab === "chunks") {
      return renderChunkPanel();
    }

    if (activeTab === "citations") {
      return renderCitationPanel();
    }

    return (
      <>
        {isSearchOpen ? (
          <div className="archive-preview-search-panel">
            <Input
              autoFocus
              placeholder="Search current source"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <span>
              {searchQuery
                ? `1 match previewed for "${searchQuery}"`
                : "Type to search this preview."}
            </span>
          </div>
        ) : null}
        {renderPagePanel()}
      </>
    );
  };

  return (
    <div
      className={`archive-preview-wrap ${
        evidence.isDemoPreview ? "archive-preview-wrap-demo" : ""
      } ${isExpanded ? "is-expanded" : ""}`}
    >
      <div className="archive-preview-document-head">
        <div>
          <div className="archive-preview-file">{evidence.fileName}</div>
          <div className="archive-preview-page">
            {hasInlinePreview
              ? `Source · ${pageLabel}`
              : ["Source", evidence.locationText].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="archive-status-dot" />
      </div>

      {renderEvidenceObject()}

      <div className="archive-preview-tabs" aria-label="Preview tabs">
        {previewTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? "is-active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="archive-preview-toolbar" aria-label="Preview controls">
        <Button
          aria-label="Show chunks"
          className="archive-icon-button"
          icon={<BookOutlined />}
          onClick={() => setActiveTab("chunks")}
        />
        <Button
          aria-label="Search in source"
          className={`archive-icon-button ${isSearchOpen ? "is-active" : ""}`}
          icon={<SearchOutlined />}
          onClick={() => {
            setActiveTab("preview");
            setIsSearchOpen((isOpen) => !isOpen);
          }}
        />
        {hasInlinePreview ? (
          <span className="archive-page-stepper">
            <button type="button" aria-label="Previous page" onClick={() => updatePage(-1)}>
              ‹
            </button>
            {pageLabel}
            <button type="button" aria-label="Next page" onClick={() => updatePage(1)}>
              ›
            </button>
          </span>
        ) : null}
        {source.demoPreview ? (
          <span className="archive-zoom-stepper">
            <button type="button" aria-label="Zoom out" onClick={() => updateZoom(-10)}>
              −
            </button>
            {zoom}%
            <button type="button" aria-label="Zoom in" onClick={() => updateZoom(10)}>
              +
            </button>
          </span>
        ) : null}
        {previewUrl ? (
          <Button
            className="archive-secondary-button archive-preview-open-button"
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            icon={<DownloadOutlined />}
          >
            Open
          </Button>
        ) : null}
        <Button
          aria-label={isExpanded ? "Collapse preview" : "Expand preview"}
          className={`archive-icon-button ${isExpanded ? "is-active" : ""}`}
          icon={<ExpandOutlined />}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        />
      </div>

      <div className="archive-preview-active-panel">{renderActiveTab()}</div>
    </div>
  );
};

export default React.memo(PdfPreview);
