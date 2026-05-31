import React from "react";
import { Spin } from "antd";

const formatLookupCount = (count) => {
  if (!Number.isFinite(count)) {
    return "Results unknown";
  }

  return count === 1 ? "1 result" : `${count} results`;
};

const formatAgentMode = (mode) => {
  if (!mode) {
    return "Agent";
  }

  return mode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" + ");
};

const formatTraceStatus = (status) => {
  if (!status) {
    return "completed";
  }

  return status.replace(/_/g, " ");
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const formatDetailLabel = (label) =>
  label
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());

const formatDetailValue = (value) => {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "N/A";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const primitiveValues = value.filter(
      (item) => ["string", "number", "boolean"].includes(typeof item)
    );

    return primitiveValues.length > 0
      ? primitiveValues.map(formatDetailValue).join(", ")
      : null;
  }

  return null;
};

const formatBudgetCounter = (usedValue, limitValue) => {
  const used = Number.isFinite(usedValue) ? usedValue : 0;

  if (!Number.isFinite(limitValue)) {
    return String(used);
  }

  return `${used} / ${limitValue}`;
};

const BUDGET_ITEMS = [
  {
    label: "Doc RAG",
    usedKey: "documentRagCalls",
    limitKey: "maxDocumentRagCalls",
  },
  {
    label: "Web",
    usedKey: "webSearchCalls",
    limitKey: "maxWebSearchCalls",
  },
  {
    label: "Research",
    usedKey: "researchQuestions",
    limitKey: "maxResearchQuestions",
  },
  {
    label: "Trace",
    usedKey: "traceSteps",
    limitKey: "maxTraceSteps",
  },
];

const TraceDetailRows = ({ rows }) => {
  const visibleRows = rows.filter(
    ({ value }) => value !== null && value !== undefined && value !== ""
  );

  if (visibleRows.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-detail-grid">
      {visibleRows.map(({ label, value }) => (
        <div key={label} className="archive-agent-detail-row">
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
};

const TraceBudgetSnapshot = ({ budget }) => {
  if (!isPlainObject(budget)) {
    return null;
  }

  const limits = isPlainObject(budget.limits) ? budget.limits : {};
  const used = isPlainObject(budget.used) ? budget.used : {};

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">Budget</div>
      <div className="archive-agent-budget-grid">
        {BUDGET_ITEMS.map((item) => (
          <div key={item.usedKey} className="archive-agent-budget-item">
            <span>{item.label}</span>
            <strong>{formatBudgetCounter(used[item.usedKey], limits[item.limitKey])}</strong>
          </div>
        ))}
        {budget.traceTruncated ? (
          <div className="archive-agent-budget-item is-warning">
            <span>Trace</span>
            <strong>Capped</strong>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const TraceActionList = ({ label, items, getTitle, getCopy }) => {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">{label}</div>
      <div className="archive-agent-detail-list">
        {items.map((item, index) => (
          <div
            key={item.id ?? `${label}-${index}`}
            className="archive-agent-detail-list-item"
          >
            <span>{getTitle(item, index)}</span>
            {getCopy(item, index) ? <p>{getCopy(item, index)}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const TraceReasonList = ({ reasons }) => {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">Reasons</div>
      <div className="archive-agent-reason-list">
        {reasons.map((reason) => (
          <span key={reason} className="archive-agent-detail-chip">
            {reason}
          </span>
        ))}
      </div>
    </div>
  );
};

const GenericTraceDetail = ({ detail, exclude = [] }) => {
  const excludedKeys = new Set(exclude);
  const rows = Object.entries(detail)
    .filter(([key]) => !excludedKeys.has(key))
    .map(([key, value]) => ({
      label: formatDetailLabel(key),
      value: formatDetailValue(value),
    }))
    .filter(({ value }) => value !== null);

  return <TraceDetailRows rows={rows} />;
};

const AgentTraceDetail = ({ step }) => {
  const detail = step?.detail;

  if (!isPlainObject(detail)) {
    return null;
  }

  if (step.type === "plan") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Mode", value: formatAgentMode(detail.mode) },
            {
              label: "Documents",
              value: Array.isArray(detail.docIds)
                ? `${detail.docIds.length} selected`
                : null,
            },
          ]}
        />
        <TraceActionList
          label="Actions"
          items={detail.actions}
          getTitle={(action, index) =>
            action.label ?? action.id ?? `Action ${index + 1}`
          }
          getCopy={(action) => action.summary}
        />
        <TraceBudgetSnapshot budget={detail.budget} />
      </div>
    );
  }

  if (step.type === "research_plan") {
    return (
      <div className="archive-agent-detail">
        <TraceActionList
          label="Questions"
          items={detail.questions}
          getTitle={(question, index) => question.id ?? `Question ${index + 1}`}
          getCopy={(question) => question.question}
        />
      </div>
    );
  }

  if (step.type === "research_question") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Citations", value: formatDetailValue(detail.citations) },
            { label: "Abstained", value: formatDetailValue(detail.abstained) },
            { label: "Error", value: formatDetailValue(detail.error) },
          ]}
        />
      </div>
    );
  }

  if (step.type === "self_check") {
    return (
      <div className="archive-agent-detail">
        <div className="archive-agent-budget-grid">
          <div className="archive-agent-budget-item">
            <span>Citations</span>
            <strong>
              {formatBudgetCounter(
                detail.citationCount,
                detail.requiredCitationCount
              )}
            </strong>
          </div>
          <div className="archive-agent-budget-item">
            <span>Docs</span>
            <strong>
              {formatBudgetCounter(detail.citedDocCount, detail.requiredDocCoverage)}
            </strong>
          </div>
          <div className="archive-agent-budget-item">
            <span>Retry</span>
            <strong>{formatDetailValue(detail.retryRecommended)}</strong>
          </div>
          <div className="archive-agent-budget-item">
            <span>Passed</span>
            <strong>{formatDetailValue(detail.passed)}</strong>
          </div>
        </div>
        <TraceReasonList reasons={detail.reasons} />
      </div>
    );
  }

  if (step.type === "document_retry") {
    return (
      <div className="archive-agent-detail">
        <div className="archive-agent-detail-question">{detail.retryQuestion}</div>
      </div>
    );
  }

  if (step.type === "budget_limit") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Tool", value: formatDetailValue(detail.tool) },
            { label: "Reason", value: formatDetailValue(detail.reason) },
          ]}
        />
      </div>
    );
  }

  if (isPlainObject(detail.budget)) {
    return (
      <div className="archive-agent-detail">
        <GenericTraceDetail detail={detail} exclude={["budget"]} />
        <TraceBudgetSnapshot budget={detail.budget} />
      </div>
    );
  }

  return (
    <div className="archive-agent-detail">
      <GenericTraceDetail detail={detail} />
    </div>
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
  } = props;

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
              {each.answer?.agentAnswer ? (
                <div className="archive-agent-panel">
                  <div className="archive-answer-label-wrap">
                    <div className="archive-answer-label">Agent answer</div>
                    <span className="archive-answer-chip archive-answer-chip-agent">
                      {formatAgentMode(each.answer.agentMode)}
                    </span>
                  </div>

                  <div className="archive-answer-text archive-agent-answer">
                    {each.answer.agentAnswer}
                  </div>

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
                </div>
              ) : null}

              <div className="archive-response-section">
                <div className="archive-answer-label-wrap">
                  <div className="archive-answer-label">Document answer</div>
                  {each.answer?.ragMemoryApplied ? (
                    <span className="archive-answer-chip">Memory</span>
                  ) : null}
                </div>

                <div className="archive-answer-text">{each.answer.ragAnswer}</div>

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
                      <button
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
                      >
                        <div className="archive-source-head">
                          <span>{source.fileName}</span>
                          <span>
                            {source.pageNumber ? `Page ${source.pageNumber}` : ""}
                          </span>
                        </div>
                        <div className="archive-source-copy">{source.excerpt}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="archive-response-divider" />

              <div className="archive-response-section archive-response-section-secondary">
                <div className="archive-answer-label-wrap">
                  <div className="archive-answer-label">Web answer</div>
                  {each.answer?.errors?.mcp ? (
                    <span className="archive-answer-chip is-muted">Fallback</span>
                  ) : null}
                </div>

                <div className="archive-answer-text">{each.answer.mcpAnswer}</div>
              </div>
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
