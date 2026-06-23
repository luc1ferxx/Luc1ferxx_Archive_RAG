import { formatTraceCount } from "./AgentTraceDetail";
import EvidenceSummaryPanel from "./EvidenceSummaryPanel";
import { buildEvidenceSpineModel } from "./evidenceSpine";

const EvidenceSpineItem = ({ item }) => (
  <div className="archive-evidence-spine-item">
    <div>
      <strong>{item.title}</strong>
      {item.copy ? <p>{item.copy}</p> : null}
    </div>
    {item.meta ? <span>{item.meta}</span> : null}
  </div>
);

const EvidenceSpineGroup = ({ group }) => {
  if (!group.items.length) {
    return null;
  }

  return (
    <div className="archive-evidence-spine-group">
      <div className="archive-agent-detail-caption">{group.label}</div>
      <div className="archive-evidence-spine-items">
        {group.items.map((item) => (
          <EvidenceSpineItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
};

const AgentTraceOverview = ({
  answer,
  evidenceSummary,
  sourceCount,
  stepCount,
}) => {
  const model = buildEvidenceSpineModel({
    answer,
    evidenceSummary,
    sourceCount,
    stepCount,
  });

  if (!model.hasContent) {
    return null;
  }

  return (
    <div className="archive-agent-inspector archive-evidence-spine">
      <div className="archive-agent-inspector-head">
        <div className="archive-source-section-label">Evidence spine</div>
        <span className="archive-answer-chip archive-answer-chip-agent">
          {formatTraceCount(model.selectedSkillCount, "skill")}
        </span>
      </div>

      <div className="archive-agent-metric-grid">
        {model.metrics.map((metric) => (
          <div key={metric.label} className="archive-agent-metric">
            <span>{metric.label}</span>
            <strong title={metric.title}>{metric.value}</strong>
          </div>
        ))}
      </div>

      <div className="archive-evidence-spine-list">
        {model.stages.map((stage) => (
          <section
            key={stage.id}
            className={`archive-evidence-spine-stage is-${stage.status}`}
          >
            <div className="archive-evidence-spine-marker" aria-hidden="true" />
            <div className="archive-evidence-spine-stage-body">
              <div className="archive-evidence-spine-stage-head">
                <strong>{stage.label}</strong>
                <span>{stage.meta}</span>
              </div>
              {stage.hasEvidenceSummary ? (
                <EvidenceSummaryPanel
                  summary={evidenceSummary}
                  sourceCount={sourceCount}
                  variant="spine"
                />
              ) : null}
              {stage.groups.map((group) => (
                <EvidenceSpineGroup key={group.label} group={group} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export default AgentTraceOverview;
