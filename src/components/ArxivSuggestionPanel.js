import { Button } from "antd";
import {
  CloseOutlined,
  DownloadOutlined,
  FileSearchOutlined,
} from "@ant-design/icons";

const getPaperLabel = (paper = {}) =>
  paper.arxivId ? `arXiv:${paper.arxivId}` : "arXiv";

const ArxivSuggestionPanel = ({
  isImporting,
  isLoading,
  onDismiss,
  onImport,
  suggestion,
}) => {
  const papers = suggestion?.papers ?? [];

  if (!isLoading && papers.length === 0) {
    return null;
  }

  const importCount = Math.min(
    suggestion?.requestedMaxResults ?? 3,
    papers.length || 3
  );

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
            Found {papers.length} papers for {suggestion.topic}.
          </div>
          <div className="arxiv-paper-list">
            {papers.slice(0, 3).map((paper) => (
              <div className="arxiv-paper-item" key={paper.arxivId ?? paper.title}>
                <span>{getPaperLabel(paper)}</span>
                <strong>{paper.title}</strong>
              </div>
            ))}
          </div>
          <div className="arxiv-suggestion-actions">
            <Button
              className="archive-secondary-button"
              icon={<DownloadOutlined />}
              loading={isImporting}
              onClick={() => void onImport?.()}
              size="small"
              type="primary"
            >
              Import {importCount}
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
