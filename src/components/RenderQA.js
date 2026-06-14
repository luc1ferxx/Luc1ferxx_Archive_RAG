import React, { useState } from "react";
import { Spin } from "antd";
import AgentTraceDetail, {
  formatAgentMode,
  formatTraceStatus,
} from "./AgentTraceDetail";
import AgentTraceOverview from "./AgentTraceOverview";
import EvidenceSummaryPanel from "./EvidenceSummaryPanel";
import SpotlightCard from "./react-bits/SpotlightCard";

const FEEDBACK_ACTIONS = [
  {
    type: "helpful",
    label: "Helpful",
  },
  {
    type: "citation_error",
    label: "Citation error",
  },
  {
    type: "incomplete",
    label: "Incomplete",
  },
  {
    type: "hallucination",
    label: "Hallucination",
  },
];

const formatLookupCount = (count) => {
  if (!Number.isFinite(count)) {
    return "Results unknown";
  }

  return count === 1 ? "1 result" : `${count} results`;
};

const formatRiskFlag = (flag) =>
  String(flag ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const getApprovalGates = (answer = {}) => {
  const directGates = Array.isArray(answer.approvalGates)
    ? answer.approvalGates
    : [];
  const detailGates = Array.isArray(answer.clarification?.detail?.approvalGates)
    ? answer.clarification.detail.approvalGates
    : [];
  const detailGate = answer.clarification?.detail?.approvalGate;

  if (directGates.length > 0) {
    return directGates;
  }

  if (detailGates.length > 0) {
    return detailGates;
  }

  return detailGate ? [detailGate] : [];
};

const getAgentRunSteps = (answer = {}) => {
  if (Array.isArray(answer.agentRunSteps) && answer.agentRunSteps.length > 0) {
    return answer.agentRunSteps;
  }

  return Array.isArray(answer.agentTrace)
    ? answer.agentTrace.map((step) => ({
        ...step,
        kind: step.type,
      }))
    : [];
};

const formatStepKind = (kind) =>
  String(kind ?? "step")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const ApprovalGatePanel = ({ gates, onApprovalAction, turnIndex }) => {
  if (!Array.isArray(gates) || gates.length === 0) {
    return null;
  }

  return (
    <div className="archive-approval-panel" aria-label="Pending approvals">
      <div className="archive-source-section-label">Pending approval</div>
      {gates.map((gate, gateIndex) => {
        const inputPreview = gate.inputPreview ?? {};
        const previewEntries = Object.entries(inputPreview);
        const riskFlags = Array.isArray(gate.riskFlags) ? gate.riskFlags : [];

        return (
          <div key={gate.id ?? gate.capabilityId ?? gateIndex} className="archive-approval-item">
            <div className="archive-approval-head">
              <strong>{gate.capabilityLabel ?? gate.capabilityId ?? "Capability"}</strong>
              <span>{gate.status ?? "pending"}</span>
            </div>
            {gate.reason ? (
              <div className="archive-approval-copy">{gate.reason}</div>
            ) : null}
            {previewEntries.length > 0 ? (
              <div className="archive-approval-preview">
                {previewEntries.map(([field, value]) => (
                  <div key={field} className="archive-approval-preview-row">
                    <span>{field}</span>
                    <strong>{Array.isArray(value) ? value.join(", ") : String(value)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="archive-approval-copy">Input preview hidden by policy.</div>
            )}
            {riskFlags.length > 0 ? (
              <div className="archive-approval-risk-list">
                {riskFlags.map((flag) => (
                  <span key={flag} className="archive-answer-chip is-warning">
                    {formatRiskFlag(flag)}
                  </span>
                ))}
              </div>
            ) : null}
            {onApprovalAction && gate.status === "pending" ? (
              <div className="archive-approval-actions">
                <button
                  type="button"
                  className="archive-approval-button is-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    onApprovalAction({
                      action: "approve",
                      gate,
                      turnIndex,
                    });
                  }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="archive-approval-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onApprovalAction({
                      action: "deny",
                      gate,
                      turnIndex,
                    });
                  }}
                >
                  Deny
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

const AgentRunRail = ({ steps }) => {
  const visibleSteps = steps.slice(0, 5);

  if (visibleSteps.length === 0) {
    return null;
  }

  return (
    <div className="archive-run-rail" aria-label="Agent run steps">
      {visibleSteps.map((step, stepIndex) => {
        const stepStatus = step.status ?? "completed";

        return (
          <div
            key={step.id ?? `${step.label}-${stepIndex}`}
            className={`archive-run-stage is-${stepStatus}`}
          >
            <span className="archive-run-stage-index">{stepIndex + 1}</span>
            <span className="archive-run-stage-label">{step.label}</span>
          </div>
        );
      })}
    </div>
  );
};

const AgentRunTimeline = ({ steps }) => {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  return (
    <div className="archive-run-timeline" aria-label="Agent run timeline">
      <div className="archive-source-section-label">Run timeline</div>
      <div className="archive-run-timeline-list">
        {steps.map((step, stepIndex) => {
          const stepStatus = step.status ?? "completed";

          return (
            <div
              key={step.id ?? `${step.label}-${stepIndex}`}
              className={`archive-run-timeline-item is-${stepStatus}`}
            >
              <span className="archive-run-timeline-dot" />
              <div className="archive-run-timeline-body">
                <div className="archive-run-timeline-head">
                  <strong>{step.label ?? step.type ?? "Step"}</strong>
                  <span>{formatTraceStatus(stepStatus)}</span>
                </div>
                <div className="archive-run-timeline-meta">
                  <span>{formatStepKind(step.kind ?? step.type)}</span>
                  {step.attempt > 1 ? <span>Attempt {step.attempt}</span> : null}
                </div>
                {step.summary ? (
                  <div className="archive-run-timeline-copy">{step.summary}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const DemoWorkbenchAnswer = ({ answer, onSelectSource }) => {
  const sources = answer.ragSources ?? [];
  const trace = answer.agentTrace ?? [];
  const [showAllSources, setShowAllSources] = useState(false);
  const [isTraceVisible, setIsTraceVisible] = useState(true);
  const [isDetailVisible, setIsDetailVisible] = useState(false);
  const extendedSources = [
    ...sources,
    {
      docId: "demo-procurement",
      fileName: "Procurement Guidelines.docx",
      filePath: "",
      pageNumber: 18,
      chunkIndex: 7,
      rank: 4,
      excerpt: "Vendor travel purchases require manager approval above policy thresholds.",
    },
    {
      docId: "demo-vendor-management",
      fileName: "Vendor Management Policy.pdf",
      filePath: "",
      pageNumber: 9,
      chunkIndex: 5,
      rank: 5,
      excerpt: "Vendor reimbursement terms should be checked against active contracts.",
    },
  ];
  const visibleSources = showAllSources ? extendedSources : sources;

  return (
    <SpotlightCard
      as="div"
      className="archive-demo-answer-card"
      spotlightColor="rgba(39, 110, 241, 0.08)"
    >
      <div className="archive-demo-answer-head">
        <div className="archive-demo-agent">
          <span className="archive-agent-avatar">◎</span>
          <strong>AgentRAG (v1)</strong>
          <span>10:42 AM</span>
          <span className="archive-status-dot" />
        </div>
        <span>2.8s</span>
      </div>

      <div className="archive-answer-text archive-agent-answer">
        {answer.agentAnswer}
      </div>

      <div className="archive-demo-table-block">
        <strong>Per diem limits (daily)</strong>
        <table className="archive-demo-answer-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Location Examples</th>
              <th>Total Per Diem (USD)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Tier 1 (High Cost)</td>
              <td>Switzerland, Norway, Japan</td>
              <td>$320</td>
            </tr>
            <tr>
              <td>Tier 2 (Mid Cost)</td>
              <td>Germany, France, UAE</td>
              <td>$260</td>
            </tr>
            <tr>
              <td>Tier 3 (Lower Cost)</td>
              <td>India, Mexico, Brazil</td>
              <td>$180</td>
            </tr>
          </tbody>
        </table>
        <p>Receipts are required for expenses over $75. Alcohol is not reimbursable.</p>
        <p>See policy for full details and exceptions.</p>
      </div>

      <div className="archive-demo-source-row">
        {visibleSources.map((source, sourceIndex) => (
          <button
            key={`${source.docId}-${source.rank}`}
            type="button"
            className="archive-demo-source-chip"
            onClick={(event) => {
              event.stopPropagation();
              onSelectSource?.(source);
            }}
          >
            <span>{sourceIndex + 1}</span>
            <strong>{source.fileName}</strong>
            <small>pp. {source.pageNumber}</small>
          </button>
        ))}
        <button
          type="button"
          className="archive-demo-source-chip is-more"
          onClick={() => setShowAllSources((isExpanded) => !isExpanded)}
        >
          {showAllSources ? "Show top 3 sources" : "View all 5 sources"}
        </button>
      </div>

      <div className="archive-demo-trace-panel">
        <div className="archive-demo-trace-head">
          <button
            type="button"
            onClick={() => setIsTraceVisible((isVisible) => !isVisible)}
          >
            {isTraceVisible ? "⌃ Hide trace" : "⌄ Show trace"}
          </button>
        </div>
        {isTraceVisible ? (
          <div className="archive-demo-trace-row">
            {trace.map((step, index) => (
              <div key={step.id} className="archive-demo-trace-step">
                <span className="archive-demo-check">✓</span>
                <div className="archive-demo-trace-line" />
                <strong>{step.label}</strong>
                <small>{index === 0 ? "0.2s" : index === 1 ? "0.6s" : index === 2 ? "0.4s" : index === 3 ? "1.2s" : "0.4s"}</small>
              </div>
            ))}
          </div>
        ) : null}
        {isDetailVisible ? (
          <div className="archive-demo-detail-panel">
            {trace.map((step) => (
              <div key={`detail-${step.id}`}>
                <strong>{step.label}</strong>
                <span>{step.summary}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="archive-demo-metric-footer">
          <span>Groundedness 91%</span>
          <span>Context coverage 92%</span>
          <span>Tokens 1,732 ↓ 23%</span>
          <button
            type="button"
            onClick={() => setIsDetailVisible((isVisible) => !isVisible)}
          >
            {isDetailVisible ? "Hide details" : "View details"}
          </button>
        </div>
      </div>
    </SpotlightCard>
  );
};

const RenderQA = (props) => {
  const {
    conversation,
    activeTurnIndex,
    isLoading,
    selectedSource,
    onSelectSource,
    onSelectTurn,
    onApprovalAction,
    onFeedback,
  } = props;
  const [feedbackNotes, setFeedbackNotes] = useState({});

  const updateFeedbackNote = (turnIndex, note) => {
    setFeedbackNotes((prev) => ({
      ...prev,
      [turnIndex]: note,
    }));
  };

  const submitFeedback = ({ turnIndex, feedbackType, turn }) => {
    onFeedback?.({
      turnIndex,
      feedbackType,
      note: feedbackNotes[turnIndex] ?? "",
      question: turn.question,
      answer: turn.answer,
    });
    updateFeedbackNote(turnIndex, "");
  };

  if (!conversation?.length && !isLoading) {
    return (
      <div className="archive-empty-log">
        <div className="archive-empty-mark">No conversation yet</div>
        <div>Upload documents on the left, then ask a question to begin.</div>
      </div>
    );
  }

  return (
    <div className="archive-log">
      {conversation?.map((each, index) => {
        const gapPlan = each.answer?.ragGapPlan;
        const agentTrace = each.answer?.agentTrace ?? [];
        const agentRunSteps = getAgentRunSteps(each.answer);
        const approvalGates = getApprovalGates(each.answer);
        const evidenceSummary = each.answer?.ragEvidenceSummary;
        const researchBrief = each.answer?.researchBrief;

        return (
          <article
            key={index}
            className={`archive-entry ${
              activeTurnIndex === index ? "is-active" : ""
            }`}
            onClick={() => onSelectTurn?.(index)}
          >
            <div className="archive-entry-eyebrow">Prompt {index + 1}</div>

            <div className="archive-question">
              <div className="archive-question-label">You</div>
              <div className="archive-question-text">{each.question}</div>
            </div>

            <section className="archive-response">
              {each.answer?.demoWorkbench ? (
                <DemoWorkbenchAnswer
                  answer={each.answer}
                  onSelectSource={onSelectSource}
                />
              ) : (
                <>
              {each.answer?.agentAnswer ? (
                <SpotlightCard
                  as="div"
                  className="archive-agent-panel"
                  spotlightColor="rgba(15, 159, 122, 0.08)"
                >
                  <div className="archive-answer-label-wrap">
                    <div className="archive-answer-label">Agent answer</div>
                    <span className="archive-answer-chip archive-answer-chip-agent">
                      {formatAgentMode(each.answer.agentMode)}
                    </span>
                  </div>

                  <AgentRunRail steps={agentRunSteps} />

                  <div className="archive-answer-text archive-agent-answer">
                    {each.answer.agentAnswer}
                  </div>

                  <ApprovalGatePanel
                    gates={approvalGates}
                    onApprovalAction={onApprovalAction}
                    turnIndex={index}
                  />

                  <AgentRunTimeline steps={agentRunSteps} />

                  <AgentTraceOverview
                    answer={each.answer}
                    stepCount={agentTrace.length}
                  />

                  {agentTrace.length > 0 ? (
                    <div className="archive-agent-trace">
                      {agentTrace.map((step) => {
                        const stepStatus = step.status ?? "completed";

                        return (
                          <div
                            key={step.id}
                            className={`archive-agent-step is-${stepStatus}`}
                          >
                            <div className="archive-agent-step-head">
                              <span>{step.label}</span>
                              <span>{formatTraceStatus(stepStatus)}</span>
                            </div>
                            <div className="archive-agent-step-copy">
                              {step.summary}
                            </div>
                            <AgentTraceDetail step={step} />
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {researchBrief?.questions?.length > 0 ? (
                    <div className="archive-research-panel">
                      <div className="archive-source-section-label">
                        Research brief
                      </div>
                      <div className="archive-research-meta">
                        <span>
                          {researchBrief.questions.length} subquestions
                        </span>
                        <span>
                          {researchBrief.citations?.length ?? 0} citations
                        </span>
                      </div>
                      <div className="archive-research-question-list">
                        {researchBrief.questions.map((question) => (
                          <div
                            key={question.id}
                            className={`archive-research-question is-${question.status}`}
                          >
                            <span>{question.question}</span>
                            <span>{question.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </SpotlightCard>
              ) : null}

              <SpotlightCard
                as="div"
                className="archive-response-section"
                spotlightColor="rgba(39, 110, 241, 0.08)"
              >
                <div className="archive-answer-label-wrap">
                  <div className="archive-answer-label">Document answer</div>
                  {each.answer?.ragMemoryApplied ? (
                    <span className="archive-answer-chip">Memory</span>
                  ) : null}
                </div>

                <div className="archive-answer-text">{each.answer.ragAnswer}</div>

                <EvidenceSummaryPanel summary={evidenceSummary} />

                {gapPlan ? (
                  <div className="archive-gap-panel">
                    {gapPlan.missingAspects?.length > 0 ? (
                      <div className="archive-gap-block">
                        <div className="archive-source-section-label">
                          Missing evidence
                        </div>
                        <div className="archive-gap-list">
                          {gapPlan.missingAspects.map((aspect) => (
                            <div key={aspect.label} className="archive-gap-item">
                              <div className="archive-gap-item-title">{aspect.label}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {gapPlan.supplementalSearches?.length > 0 ? (
                      <div className="archive-gap-block">
                        <div className="archive-source-section-label">
                          Extra lookups
                        </div>
                        <div className="archive-gap-list">
                          {gapPlan.supplementalSearches.map((lookup) => (
                            <div
                              key={`${lookup.label}-${lookup.query}`}
                              className="archive-gap-item"
                            >
                              <div className="archive-gap-item-head">
                                <div className="archive-gap-item-title">
                                  {lookup.label}
                                </div>
                                <span className="archive-gap-badge">
                                  {formatLookupCount(lookup.resultCount)}
                                </span>
                              </div>
                              <div className="archive-gap-item-copy">
                                Search: {lookup.query}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {each.answer.ragSources?.length > 0 && (
                  <div className="archive-source-list">
                    <div className="archive-source-section-label">Citations</div>

                    {each.answer.ragSources.map((source) => (
                      <SpotlightCard
                        as="button"
                        key={`${source.docId}-${source.chunkIndex}-${source.rank}`}
                        type="button"
                        className={`archive-source-item ${
                          selectedSource?.docId === source.docId &&
                          selectedSource?.chunkIndex === source.chunkIndex
                            ? "is-selected"
                            : ""
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectTurn?.(index);
                          onSelectSource?.(source);
                        }}
                        spotlightColor="rgba(39, 110, 241, 0.1)"
                      >
                        <div className="archive-source-head">
                          <span>{source.fileName}</span>
                          <span>
                            {source.pageNumber ? `Page ${source.pageNumber}` : ""}
                          </span>
                        </div>
                        <div className="archive-source-copy">{source.excerpt}</div>
                      </SpotlightCard>
                    ))}
                  </div>
                )}

                <div
                  className="archive-feedback-panel"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    className="archive-feedback-input"
                    placeholder="Optional feedback note"
                    value={feedbackNotes[index] ?? ""}
                    onChange={(event) =>
                      updateFeedbackNote(index, event.target.value)
                    }
                  />
                  <div className="archive-feedback-actions">
                    {FEEDBACK_ACTIONS.map((action) => (
                      <button
                        key={action.type}
                        type="button"
                        className="archive-feedback-button"
                        onClick={() =>
                          submitFeedback({
                            turnIndex: index,
                            feedbackType: action.type,
                            turn: each,
                          })
                        }
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              </SpotlightCard>

              <div className="archive-response-divider" />

              <SpotlightCard
                as="div"
                className="archive-response-section archive-response-section-secondary"
                spotlightColor="rgba(105, 120, 240, 0.08)"
              >
                <div className="archive-answer-label-wrap">
                  <div className="archive-answer-label">Web answer</div>
                  {each.answer?.errors?.mcp ? (
                    <span className="archive-answer-chip is-muted">Fallback</span>
                  ) : null}
                </div>

                <div className="archive-answer-text">{each.answer.mcpAnswer}</div>
              </SpotlightCard>
                </>
              )}
            </section>
          </article>
        );
      })}

      {isLoading && (
        <div className="archive-loading">
          <Spin size="large" />
          <div className="archive-loading-copy">Generating an answer...</div>
        </div>
      )}
    </div>
  );
};

export default RenderQA;
