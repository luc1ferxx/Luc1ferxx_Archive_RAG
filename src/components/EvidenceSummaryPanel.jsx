import {
  isPlainObject,
} from "./AgentTraceDetail";
import { getEvidenceSummaryDetails } from "./evidenceSpine";

const EvidenceSummaryPanel = ({ summary, sourceCount, variant = "card" }) => {
  if (!isPlainObject(summary) && !Number.isFinite(sourceCount)) {
    return null;
  }

  const details = getEvidenceSummaryDetails(summary, sourceCount);

  if (!details.hasEvidence) {
    return null;
  }

  return (
    <div
      className={`archive-evidence-panel archive-evidence-panel-${variant} ${
        details.confident ? "is-confident" : "is-weak"
      }`}
    >
      <div className="archive-evidence-head">
        <span>Evidence</span>
        <strong>{details.statusLabel}</strong>
      </div>

      <div className="archive-evidence-grid">
        {details.metrics.map((metric) => (
          <div key={metric.label} className="archive-evidence-metric">
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      {details.requirements.length > 1 ? (
        <div className="archive-evidence-requirements">
          {details.requirements.map((requirement) => (
            <span key={requirement.id}>{requirement.label}</span>
          ))}
        </div>
      ) : null}

      {details.reasons[0] ? <p>{details.reasons[0]}</p> : null}
    </div>
  );
};

export default EvidenceSummaryPanel;
