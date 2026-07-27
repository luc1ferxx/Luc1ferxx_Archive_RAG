import { useMemo, useState } from "react";
import { Button } from "antd";
import {
  CloseOutlined,
  DownloadOutlined,
  FileSearchOutlined,
} from "@ant-design/icons";

const EMPTY_PAPERS = [];

const getPaperLabel = (paper = {}) =>
  paper.arxivId ? `arXiv:${paper.arxivId}` : "arXiv";

const getSanitizedTopic = (suggestion) => {
  const safeSuggestion = suggestion ?? {};

  return (
    safeSuggestion.queryPolicy?.sanitizedQuery ||
    safeSuggestion.trace?.externalQueryPolicy?.sanitizedQuery ||
    safeSuggestion.topic ||
    ""
  );
};

const ArxivSuggestionPanel = ({
  isImporting,
  isLoading,
  onDismiss,
  onImport,
  suggestion,
}) => {
  const papers = suggestion?.papers ?? EMPTY_PAPERS;
  const paperIds = useMemo(
    () => papers.map((paper) => paper.arxivId).filter(Boolean),
    [papers]
  );
  const paperIdsKey = paperIds.join("\n");
  const [selectionState, setSelectionState] = useState({
    paperIdsKey: "",
    selectedPaperIds: [],
  });

  if (!isLoading && papers.length === 0) {
    return null;
  }

  const selectedPaperIds =
    selectionState.paperIdsKey === paperIdsKey
      ? selectionState.selectedPaperIds
      : paperIds;
  const selectedCount = selectedPaperIds.length;
  const sanitizedTopic = getSanitizedTopic(suggestion);

  const handlePaperToggle = (paperId, checked) => {
    setSelectionState((currentSelectionState) => {
      const currentPaperIds =
        currentSelectionState.paperIdsKey === paperIdsKey
          ? currentSelectionState.selectedPaperIds
          : paperIds;
      let nextPaperIds;

      if (checked) {
        nextPaperIds = currentPaperIds.includes(paperId)
          ? currentPaperIds
          : [...currentPaperIds, paperId];
      } else {
        nextPaperIds = currentPaperIds.filter(
          (currentPaperId) => currentPaperId !== paperId
        );
      }

      return {
        paperIdsKey,
        selectedPaperIds: nextPaperIds,
      };
    });
  };

  return (
    <div className="arxiv-suggestion-panel" aria-live="polite">
      <div className="arxiv-suggestion-head">
        <div className="arxiv-suggestion-title">
          <FileSearchOutlined />
          <span>arXiv recommendations</span>
        </div>
        <Button
          aria-label="Dismiss arXiv recommendations"
          className="arxiv-suggestion-dismiss"
          icon={<CloseOutlined />}
          onClick={onDismiss}
          size="small"
          type="text"
        />
      </div>

      {isLoading ? (
        <div className="arxiv-suggestion-loading">Checking related papers...</div>
      ) : (
        <>
          <div className="arxiv-suggestion-copy">
            Found {papers.length} papers for {sanitizedTopic}. Choose which
            ones to import.
          </div>
          {sanitizedTopic ? (
            <div className="arxiv-query-policy-note">
              <span>arXiv search uses cleaned topic:</span>
              <strong className="arxiv-query-policy-topic">
                {sanitizedTopic}
              </strong>
            </div>
          ) : null}
          <div className="arxiv-paper-list">
            {papers.map((paper) => {
              const paperId = paper.arxivId;
              const isSelected = selectedPaperIds.includes(paperId);

              return (
                <div
                  className={`arxiv-paper-item ${isSelected ? "is-selected" : ""}`}
                  key={paper.arxivId ?? paper.title}
                >
                  <label className="arxiv-paper-checkbox">
                    <input
                      aria-label={`Select ${paper.title || getPaperLabel(paper)}`}
                      checked={isSelected}
                      className="arxiv-paper-checkbox-input"
                      disabled={!paperId || isImporting}
                      onChange={(event) =>
                        handlePaperToggle(paperId, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span className="arxiv-paper-body">
                      <span className="arxiv-paper-id">{getPaperLabel(paper)}</span>
                      <strong>{paper.title}</strong>
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="arxiv-selection-summary">
            {selectedCount} of {papers.length} selected
          </div>
          <div className="arxiv-suggestion-actions">
            <Button
              className="archive-secondary-button"
              disabled={selectedCount === 0}
              icon={<DownloadOutlined />}
              loading={isImporting}
              onClick={() => void onImport?.(selectedPaperIds)}
              size="small"
              type="primary"
            >
              Import {selectedCount}
            </Button>
            <Button
              className="archive-secondary-button"
              disabled={isImporting}
              onClick={onDismiss}
              size="small"
            >
              Not now
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default ArxivSuggestionPanel;
