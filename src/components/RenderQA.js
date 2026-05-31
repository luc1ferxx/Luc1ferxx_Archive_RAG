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
                      {agentTrace.map((step) => (
                        <div
                          key={step.id}
                          className={`archive-agent-step is-${step.status}`}
                        >
                          <div className="archive-agent-step-head">
                            <span>{step.label}</span>
                            <span>{step.status}</span>
                          </div>
                          <div className="archive-agent-step-copy">
                            {step.summary}
                          </div>
                        </div>
                      ))}
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
