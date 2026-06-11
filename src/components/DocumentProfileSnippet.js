import { getDocumentSummary, getDocumentTags } from "../archiveWorkspace";

const DocumentProfileSnippet = ({ document, compact = false }) => {
  const tags = getDocumentTags(document).slice(0, compact ? 3 : 5);
  const summary = getDocumentSummary(document);

  if (tags.length === 0 && !summary) {
    return null;
  }

  return (
    <div className={`document-profile ${compact ? "is-compact" : ""}`}>
      {tags.length > 0 ? (
        <div className="document-tag-list">
          {tags.map((tag) => (
            <span key={tag} className="document-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {summary ? <div className="document-summary">{summary}</div> : null}
    </div>
  );
};

export default DocumentProfileSnippet;
