import {
  formatBudgetCounter,
  formatDetailValue,
  isPlainObject,
} from "./AgentTraceDetail";

const formatEvidenceScore = (value) =>
  typeof value === "number" ? value.toFixed(2) : "N/A";

const EvidenceSummaryPanel = ({ summary }) => {
  if (!isPlainObject(summary)) {
    return null;
  }

  const docCoverage = isPlainObject(summary.docCoverage)
    ? summary.docCoverage
    : {};
  const scoreRange = isPlainObject(summary.scoreRange)
    ? summary.scoreRange
    : {};
  const requirements = Array.isArray(summary.requirements)
    ? summary.requirements
    : [];
  const reasons = Array.isArray(summary.reasons) ? summary.reasons : [];

  return (
    <div className={`archive-evidence-panel ${summary.confident ? "is-confident" : "is-weak"}`}>
      <div className="archive-evidence-head">
        <span>Evidence</span>
        <strong>{summary.confident ? "Confident" : "Limited"}</strong>
      </div>

      <div className="archive-evidence-grid">
        <div className="archive-evidence-metric">
          <span>Retrieved</span>
          <strong>{formatDetailValue(summary.retrievedCount)}</strong>
        </div>
        <div className="archive-evidence-metric">
          <span>Usable</span>
          <strong>{formatDetailValue(summary.usableCount)}</strong>
        </div>
        <div className="archive-evidence-metric">
          <span>Docs</span>
          <strong>
            {formatBudgetCounter(
              docCoverage.coveredDocIds?.length,
              docCoverage.selectedDocIds?.length
            )}
          </strong>
        </div>
        <div className="archive-evidence-metric">
          <span>Max score</span>
          <strong>{formatEvidenceScore(scoreRange.max)}</strong>
        </div>
      </div>

      {requirements.length > 1 ? (
        <div className="archive-evidence-requirements">
          {requirements.map((requirement) => (
            <span key={requirement.id}>{requirement.label}</span>
          ))}
        </div>
      ) : null}

      {reasons[0] ? <p>{reasons[0]}</p> : null}
    </div>
  );
};

export default EvidenceSummaryPanel;
