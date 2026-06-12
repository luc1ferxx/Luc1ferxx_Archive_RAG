import React, { useEffect, useState } from "react";
import { Button, Input } from "antd";
import {
  BookOutlined,
  DownloadOutlined,
  ExpandOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { API_DOMAIN } from "../config";

const PREVIEW_TABS = [
  { id: "preview", label: "Preview" },
  { id: "metadata", label: "Metadata" },
  { id: "chunks", label: "Chunks" },
  { id: "citations", label: "Citations (5)" },
];

const PdfPreview = ({ source }) => {
  const [activeTab, setActiveTab] = useState("preview");
  const [displayPage, setDisplayPage] = useState(source?.pageNumber ?? 1);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    setActiveTab("preview");
    setDisplayPage(source?.pageNumber ?? 1);
    setIsSearchOpen(false);
    setIsExpanded(false);
    setSearchQuery("");
    setZoom(100);
  }, [source?.docId, source?.chunkIndex, source?.pageNumber]);

  if (!source) {
    return (
      <div className="archive-preview-empty">
        <div className="archive-preview-empty-mark">No source selected</div>
        <div>Choose a citation to preview the related page.</div>
      </div>
    );
  }

  const pageNumber = displayPage;
  const previewMeta = source.demoPreview ?? {
    added: "Selected citation",
    description: source.excerpt || "Citation preview from the selected answer source.",
    pageRange: source.pageNumber ? String(source.pageNumber) : "1",
    tags: ["citation", "workspace", "retrieved"],
    type: source.fileName?.split(".").pop()?.toUpperCase() ?? "DOC",
  };
  const isDemoPreview = Boolean(source.demoPreview || !source.filePath);

  const updatePage = (delta) => {
    setDisplayPage((currentPage) => Math.max(1, currentPage + delta));
  };

  const updateZoom = (delta) => {
    setZoom((currentZoom) => Math.min(140, Math.max(80, currentZoom + delta)));
  };

  const renderInfoCard = () => (
    <div className="archive-preview-info-card">
      <div>
        <span>Source</span>
        <strong>{source.fileName}</strong>
      </div>
      <div>
        <span>Pages</span>
        <strong>{previewMeta.pageRange}</strong>
      </div>
      <div>
        <span>Added</span>
        <strong>{previewMeta.added}</strong>
      </div>
      <div>
        <span>Type</span>
        <strong>{previewMeta.type}</strong>
      </div>
      <div className="archive-preview-tags">
        {previewMeta.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <p>{previewMeta.description}</p>
    </div>
  );

  const renderPreviewBody = () => {
    if (!source.demoPreview) {
      return (
        <div className="archive-preview-summary-page">
          <div className="archive-preview-summary-mark">{previewMeta.type}</div>
          <strong>{source.fileName}</strong>
          <span>Page {pageNumber}</span>
          <p>{source.excerpt || previewMeta.description}</p>
        </div>
      );
    }

    return (
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
  };

  const renderActiveTab = () => {
    if (activeTab === "metadata") {
      return renderInfoCard();
    }

    if (activeTab === "chunks") {
      return (
        <div className="archive-preview-tab-panel">
          {[source.excerpt, previewMeta.description, "Neighboring chunks are ranked by retrieval score and page proximity."]
            .filter(Boolean)
            .map((chunk, index) => (
              <div key={`${chunk}-${index}`} className="archive-preview-chunk">
                <span>Chunk {index + 1}</span>
                <p>{chunk}</p>
              </div>
            ))}
        </div>
      );
    }

    if (activeTab === "citations") {
      return (
        <div className="archive-preview-tab-panel">
          <div className="archive-preview-citation">
            <span>Selected citation</span>
            <strong>{source.fileName}</strong>
            <p>Page {pageNumber} · Rank {source.rank ?? 1}</p>
          </div>
          <div className="archive-preview-citation">
            <span>Evidence note</span>
            <strong>Grounded source</strong>
            <p>{source.excerpt || previewMeta.description}</p>
          </div>
        </div>
      );
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
        {renderPreviewBody()}
      </>
    );
  };

  if (isDemoPreview) {
    return (
      <div
        className={`archive-preview-wrap archive-preview-wrap-demo ${
          isExpanded ? "is-expanded" : ""
        }`}
      >
        <div className="archive-preview-document-head">
          <div className="archive-pdf-badge">PDF</div>
          <div>
            <div className="archive-preview-file">{source.fileName}</div>
            <div className="archive-preview-page">Source · Page {pageNumber}</div>
          </div>
          <span className="archive-status-dot" />
        </div>

        <div className="archive-preview-tabs" aria-label="Preview tabs">
          {PREVIEW_TABS.map((tab) => (
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
          <span className="archive-page-stepper">
            <button type="button" aria-label="Previous page" onClick={() => updatePage(-1)}>
              ‹
            </button>
            {pageNumber} / 182
            <button type="button" aria-label="Next page" onClick={() => updatePage(1)}>
              ›
            </button>
          </span>
          <span className="archive-zoom-stepper">
            <button type="button" aria-label="Zoom out" onClick={() => updateZoom(-10)}>
              −
            </button>
            {zoom}%
            <button type="button" aria-label="Zoom in" onClick={() => updateZoom(10)}>
              +
            </button>
          </span>
          <Button
            aria-label={isExpanded ? "Collapse preview" : "Expand preview"}
            className={`archive-icon-button ${isExpanded ? "is-active" : ""}`}
            icon={<ExpandOutlined />}
            onClick={() => setIsExpanded((expanded) => !expanded)}
          />
        </div>

        {renderActiveTab()}
      </div>
    );
  }

  const previewUrl = `${API_DOMAIN}/${source.filePath}#page=${pageNumber}&view=FitH`;

  return (
    <div className="archive-preview-wrap">
      <div className="archive-preview-meta">
        <div>
          <div className="archive-preview-file">{source.fileName}</div>
          <div className="archive-preview-page">Page {pageNumber}</div>
        </div>

        <Button
          className="archive-secondary-button"
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          icon={<DownloadOutlined />}
        >
          Open full page
        </Button>
      </div>

      {source.excerpt ? (
        <p className="archive-preview-excerpt">{source.excerpt}</p>
      ) : null}

      <iframe
        className="archive-preview-frame"
        src={previewUrl}
        title={`${source.fileName} preview`}
      />
    </div>
  );
};

export default PdfPreview;
