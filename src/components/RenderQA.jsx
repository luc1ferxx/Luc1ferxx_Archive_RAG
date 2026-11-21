import React, { useCallback, useEffect, useRef, useState } from "react";
import { Spin } from "antd";
import { createTranslator } from "../archiveI18n";
import { formatDocumentLocation, getLocationUnit } from "../documentLocation";
import AgentTraceDetail, { formatAgentMode } from "./AgentTraceDetail";
import AgentTraceOverview from "./AgentTraceOverview";
import EvidenceSummaryPanel from "./EvidenceSummaryPanel";
import SpotlightCard from "./react-bits/SpotlightCard";
import {
  formatStatusLabel,
  formatStepLabel,
  isStepRetrySupported,
  toTitleWords,
  translateCode,
} from "./workbenchFormatters";

// English unless the app hands in its translator.
const defaultT = createTranslator("en");

// The feedback types the server records, each labelled by answer.feedback.<type>.
const FEEDBACK_TYPES = ["helpful", "citation_error", "incomplete", "hallucination"];

const formatLookupCount = (count, t) =>
  Number.isFinite(count) ? t("answer.resultCount", { count }) : t("answer.resultsUnknown");

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

  return Array.isArray(answer.agentTrace) ? answer.agentTrace : [];
};

// A run step's kind by its stepKind.* label, or as the server names it. A
// trace step has none: its label already names it.
const formatStepKind = (kind, t) => translateCode("stepKind", kind, t) ?? toTitleWords(kind);

const formatShortId = (value, t) => {
  const text = String(value ?? "").trim();

  if (!text) {
    return t("run.noRunId");
  }

  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
};

const stringifyDetailValue = (value) => {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getStepStatus = (step = {}) => step.status ?? "completed";

const isFailedStep = (step = {}) => getStepStatus(step) === "failed";

const isPendingGate = (gate = {}) => (gate.status ?? "pending") === "pending";

const ApprovalGatePanel = ({ gates, onApprovalAction, t, turnIndex }) => {
  if (!Array.isArray(gates) || gates.length === 0) {
    return null;
  }

  return (
    <div className="archive-approval-panel" aria-label={t("run.pendingApprovals")}>
      <div className="archive-source-section-label">{t("run.pendingApproval")}</div>
      {gates.map((gate, gateIndex) => {
        const inputPreview = gate.inputPreview ?? {};
        const previewEntries = Object.entries(inputPreview);
        const riskFlags = Array.isArray(gate.riskFlags) ? gate.riskFlags : [];

        return (
          <div key={gate.id ?? gate.capabilityId ?? gateIndex} className="archive-approval-item">
            <div className="archive-approval-head">
              <strong>{gate.capabilityLabel ?? gate.capabilityId ?? t("run.capability")}</strong>
              <span>{formatStatusLabel(gate.status, t)}</span>
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
              <div className="archive-approval-copy">{t("run.inputHidden")}</div>
            )}
            {riskFlags.length > 0 ? (
              <div className="archive-approval-risk-list">
                {riskFlags.map((flag) => (
                  <span key={flag} className="archive-answer-chip is-warning">
                    {formatStatusLabel(flag, t)}
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
                  {t("run.approve")}
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
                  {t("run.deny")}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

const AgentRunStepDetails = ({ step, stepIndex, t }) => {
  const inputText = stringifyDetailValue(step.input);
  const outputText = stringifyDetailValue(step.output);
  const errorText = stringifyDetailValue(step.error);
  const detailText = stringifyDetailValue(step.detail);
  const hasDetails = inputText || outputText || errorText || detailText;

  return (
    <details className="archive-run-control-step">
      <summary>
        <span>{String(stepIndex + 1).padStart(2, "0")}</span>
        <strong>{formatStepLabel(step, t)}</strong>
        <em>{formatStatusLabel(getStepStatus(step), t)}</em>
      </summary>
      {hasDetails ? (
        <div className="archive-run-control-step-body">
          {inputText ? (
            <div className="archive-run-control-detail">
              <span>{t("run.input")}</span>
              <pre>{inputText}</pre>
            </div>
          ) : null}
          {outputText ? (
            <div className="archive-run-control-detail">
              <span>{t("run.output")}</span>
              <pre>{outputText}</pre>
            </div>
          ) : null}
          {errorText ? (
            <div className="archive-run-control-detail is-error">
              <span>{t("common.error")}</span>
              <pre>{errorText}</pre>
            </div>
          ) : null}
          {detailText ? (
            <div className="archive-run-control-detail">
              <span>{t("run.detail")}</span>
              <pre>{detailText}</pre>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="archive-run-control-empty">{t("run.noStepDetail")}</div>
      )}
    </details>
  );
};

const AgentRunControlPanel = ({
  answer = {},
  gates = [],
  isActionPending,
  isActive,
  onApprovalAction,
  onContinueRun,
  onStepRetry,
  steps = [],
  t,
  turnIndex,
}) => {
  const runId = answer.agentRunId;
  const runStatus = answer.agentRunStatus ?? "unknown";
  // A gate is decided only while its run waits for the user: canceling a
  // waiting run leaves its gate pending (server/rag/agent-runs.js cancelRun).
  const canDecide = !answer.agentRunStatus || answer.agentRunStatus === "waiting_for_user";
  const pendingGates = canDecide ? gates.filter(isPendingGate) : [];
  const failedSteps = steps.filter(isFailedStep).filter((step) => step.id);

  if (!runId && steps.length === 0 && gates.length === 0) {
    return null;
  }

  return (
    <div
      className="archive-run-control-panel"
      aria-label={t("run.control")}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="archive-run-control-head">
        <div>
          <div className="archive-source-section-label">{t("home.agentRun")}</div>
          <strong>{formatShortId(runId, t)}</strong>
        </div>
        {!isActive && runId ? (
          <button
            type="button"
            className="archive-run-control-button"
            onClick={() =>
              onContinueRun?.({
                runId,
                turnIndex,
              })
            }
          >
            {t("run.continue")}
          </button>
        ) : null}
      </div>

      <div className="archive-run-control-metrics">
        <div>
          <span>{t("run.status")}</span>
          <strong>{formatStatusLabel(runStatus, t)}</strong>
        </div>
        <div>
          <span>{t("common.steps")}</span>
          <strong>{steps.length}</strong>
        </div>
        <div>
          <span>{t("run.approvals")}</span>
          <strong>{pendingGates.length}</strong>
        </div>
        <div>
          <span>{t("run.failed")}</span>
          <strong>{failedSteps.length}</strong>
        </div>
      </div>

      <ApprovalGatePanel
        gates={pendingGates}
        onApprovalAction={onApprovalAction}
        t={t}
        turnIndex={turnIndex}
      />

      {failedSteps.length > 0 ? (
        <div className="archive-run-retry-panel">
          <div className="archive-source-section-label">{t("run.failedSteps")}</div>
          {failedSteps.map((step) => (
            <div key={step.id} className="archive-run-retry-item">
              <div>
                <strong>{formatStepLabel(step, t)}</strong>
                <span>{step.error?.message ?? step.summary ?? t("run.stepFailed")}</span>
              </div>
              {onStepRetry && runId && isStepRetrySupported(step.type) ? (
                <button
                  type="button"
                  className="archive-run-control-button is-primary"
                  disabled={Boolean(isActionPending)}
                  onClick={() =>
                    onStepRetry({
                      runId,
                      step,
                      turnIndex,
                    })
                  }
                >
                  {t("common.retry")}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="archive-run-control-steps">
          <div className="archive-source-section-label">{t("run.stepDetails")}</div>
          {steps.map((step, stepIndex) => (
            <AgentRunStepDetails
              key={step.id ?? `${step.label}-${stepIndex}`}
              step={step}
              stepIndex={stepIndex}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const AgentRunRail = ({ steps, t }) => {
  const visibleSteps = steps.slice(0, 5);

  if (visibleSteps.length === 0) {
    return null;
  }

  return (
    <div className="archive-run-rail" aria-label={t("run.railLabel")}>
      {visibleSteps.map((step, stepIndex) => {
        const stepStatus = step.status ?? "completed";
        // The rail clips a long label; its title keeps the whole of it.
        const label = formatStepLabel(step, t);

        return (
          <div
            key={step.id ?? `${step.label}-${stepIndex}`}
            className={`archive-run-stage is-${stepStatus}`}
          >
            <span className="archive-run-stage-index">{stepIndex + 1}</span>
            <span className="archive-run-stage-label" title={label}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const AgentRunTimeline = ({ steps, t }) => {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  return (
    <div className="archive-run-timeline" aria-label={t("run.timelineLabel")}>
      <div className="archive-source-section-label">{t("run.timeline")}</div>
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
                  <strong>{formatStepLabel(step, t)}</strong>
                  <span>{formatStatusLabel(stepStatus, t)}</span>
                </div>
                <div className="archive-run-timeline-meta">
                  {step.kind ? <span>{formatStepKind(step.kind, t)}</span> : null}
                  {step.attempt > 1 ? (
                    <span>{t("run.attempt", { number: step.attempt })}</span>
                  ) : null}
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

const RenderQA = (props) => {
  const {
    conversation,
    activeTurnIndex,
    canUpload = false,
    hasDocuments = false,
    isLoading,
    selectedSource,
    onSelectSource,
    onSelectTurn,
    onApprovalAction,
    onContinueRun,
    onFeedback,
    onStepRetry,
    t = defaultT,
  } = props;
  const [feedbackNotes, setFeedbackNotes] = useState({});
  const activeTurnRef = useRef(null);

  // The chat opens on its active turn, and a new turn, made active when it
  // arrives with its answer, scrolls into view. An answer streams in the
  // composer, so nothing here moves while the user reads an earlier turn.
  // jsdom has no scrollIntoView.
  useEffect(() => {
    activeTurnRef.current?.scrollIntoView?.({ block: "start" });
  }, [conversation?.length]);

  const updateFeedbackNote = useCallback((turnIndex, note) => {
    setFeedbackNotes((prev) => ({
      ...prev,
      [turnIndex]: note,
    }));
  }, []);

  const submitFeedback = useCallback(({ turnIndex, feedbackType, turn }) => {
    onFeedback?.({
      turnIndex,
      feedbackType,
      note: feedbackNotes[turnIndex] ?? "",
      question: turn.question,
      answer: turn.answer,
    });
    setFeedbackNotes((prev) => ({
      ...prev,
      [turnIndex]: "",
    }));
  }, [onFeedback, feedbackNotes]);

  const handleTurnKeyDown = useCallback((event, index) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectTurn?.(index);
    }
  }, [onSelectTurn]);

  if (!conversation?.length && !isLoading) {
    return (
      <div className="archive-empty-log">
        <div className="archive-empty-mark">{t("chat.emptyTitle")}</div>
        <div>
          {t(
            hasDocuments
              ? "chat.emptyAsk"
              : canUpload
                ? "chat.emptyUpload"
                : "chat.emptyNoDocuments"
          )}
        </div>
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
        const ragSourceCount = Array.isArray(each.answer?.ragSources)
          ? each.answer.ragSources.length
          : undefined;

        return (
          <article
            key={index}
            ref={activeTurnIndex === index ? activeTurnRef : undefined}
            className={`archive-entry ${
              activeTurnIndex === index ? "is-active" : ""
            }`}
            onClick={() => onSelectTurn?.(index)}
            {...(onSelectTurn
              ? {
                  tabIndex: 0,
                  onKeyDown: (event) => handleTurnKeyDown(event, index),
                  "aria-current": activeTurnIndex === index ? "true" : undefined,
                  "aria-label": each.question,
                }
              : {})}
          >
            <div className="archive-entry-eyebrow">
              {t("answer.prompt", { number: index + 1 })}
            </div>

            <div className="archive-question">
              <div className="archive-question-label">{t("answer.you")}</div>
              <div className="archive-question-text">{each.question}</div>
            </div>

            <section className="archive-response">
              {each.answer?.agentAnswer ? (
                <SpotlightCard
                  as="div"
                  className="archive-agent-panel"
                  spotlightColor="rgba(15, 159, 122, 0.08)"
                >
                  <div className="archive-answer-label-wrap">
                    <div className="archive-answer-label">{t("answer.agent")}</div>
                    <span className="archive-answer-chip archive-answer-chip-agent">
                      {formatAgentMode(each.answer.agentMode, t)}
                    </span>
                  </div>

                  <AgentRunRail steps={agentRunSteps} t={t} />

                  <div className="archive-answer-text archive-agent-answer">
                    {each.answer.agentAnswer}
                  </div>

                  <AgentRunControlPanel
                    answer={each.answer}
                    gates={approvalGates}
                    isActionPending={isLoading}
                    isActive={activeTurnIndex === index}
                    onApprovalAction={onApprovalAction}
                    onContinueRun={onContinueRun}
                    onStepRetry={onStepRetry}
                    steps={agentRunSteps}
                    t={t}
                    turnIndex={index}
                  />

                  <AgentRunTimeline steps={agentRunSteps} t={t} />

                  <AgentTraceOverview
                    answer={each.answer}
                    evidenceSummary={evidenceSummary}
                    sourceCount={ragSourceCount}
                    stepCount={agentTrace.length}
                    t={t}
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
                              <span>{formatStepLabel(step, t)}</span>
                              <span>{formatStatusLabel(stepStatus, t)}</span>
                            </div>
                            <div className="archive-agent-step-copy">
                              {step.summary}
                            </div>
                            <AgentTraceDetail step={step} t={t} />
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {researchBrief?.questions?.length > 0 ? (
                    <div className="archive-research-panel">
                      <div className="archive-source-section-label">
                        {t("answer.researchBrief")}
                      </div>
                      <div className="archive-research-meta">
                        <span>
                          {t("answer.subquestionCount", {
                            count: researchBrief.questions.length,
                          })}
                        </span>
                        <span>
                          {t("trace.citationCount", {
                            count: researchBrief.citations?.length ?? 0,
                          })}
                        </span>
                      </div>
                      <div className="archive-research-question-list">
                        {researchBrief.questions.map((question) => (
                          <div
                            key={question.id}
                            className={`archive-research-question is-${question.status}`}
                          >
                            <span>{question.question}</span>
                            <span>{formatStatusLabel(question.status, t)}</span>
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
                  <div className="archive-answer-label">{t("answer.document")}</div>
                  {each.answer?.ragMemoryApplied ? (
                    <span className="archive-answer-chip">{t("answer.memory")}</span>
                  ) : null}
                </div>

                <div className="archive-answer-text">{each.answer.ragAnswer}</div>

                {!each.answer?.agentAnswer ? (
                  <EvidenceSummaryPanel
                    summary={evidenceSummary}
                    sourceCount={ragSourceCount}
                    t={t}
                  />
                ) : null}

                {gapPlan ? (
                  <div className="archive-gap-panel">
                    {gapPlan.missingAspects?.length > 0 ? (
                      <div className="archive-gap-block">
                        <div className="archive-source-section-label">
                          {t("answer.missingEvidence")}
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
                          {t("answer.extraLookups")}
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
                                  {formatLookupCount(lookup.resultCount, t)}
                                </span>
                              </div>
                              <div className="archive-gap-item-copy">
                                {t("answer.search", { query: lookup.query })}
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
                    <div className="archive-source-section-label">
                      {t("common.citations")}
                    </div>

                    {each.answer.ragSources.map((source, sourceIndex) => (
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
                          <span>
                            {sourceIndex + 1}. {source.fileName}
                          </span>
                          {/* A slide title, sheet name or section heading keeps
                              its own case (the badge is upper-cased). */}
                          <span
                            className={
                              getLocationUnit(source)
                                ? "archive-source-location"
                                : undefined
                            }
                          >
                            {formatDocumentLocation(source, t)}
                          </span>
                        </div>
                        <div className="archive-source-meta-row">
                          {Number.isFinite(source.rank) ? (
                            <span>{t("common.rankNumber", { rank: source.rank })}</span>
                          ) : null}
                          {Number.isFinite(source.chunkIndex) ? (
                            <span>
                              {t("common.chunkNumber", { number: source.chunkIndex })}
                            </span>
                          ) : null}
                          {Number.isFinite(source.score) ? (
                            <span>
                              {t("answer.score", { score: source.score.toFixed(2) })}
                            </span>
                          ) : null}
                        </div>
                        <div className="archive-source-copy">{source.excerpt}</div>
                      </button>
                    ))}
                  </div>
                )}

                <div
                  className="archive-feedback-panel"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    className="archive-feedback-input"
                    placeholder={t("answer.feedbackNote")}
                    value={feedbackNotes[index] ?? ""}
                    onChange={(event) =>
                      updateFeedbackNote(index, event.target.value)
                    }
                  />
                  <div className="archive-feedback-actions">
                    {FEEDBACK_TYPES.map((feedbackType) => (
                      <button
                        key={feedbackType}
                        type="button"
                        className="archive-feedback-button"
                        onClick={() =>
                          submitFeedback({
                            turnIndex: index,
                            feedbackType,
                            turn: each,
                          })
                        }
                      >
                        {t(`answer.feedback.${feedbackType}`)}
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
                  <div className="archive-answer-label">{t("answer.web")}</div>
                  {each.answer?.errors?.mcp ? (
                    <span className="archive-answer-chip is-muted">{t("answer.fallback")}</span>
                  ) : null}
                </div>

                <div className="archive-answer-text">{each.answer.mcpAnswer}</div>
              </SpotlightCard>
            </section>
          </article>
        );
      })}

      {isLoading && (
        <div className="archive-loading">
          <Spin size="large" />
          <div className="archive-loading-copy">{t("answer.generating")}</div>
        </div>
      )}
    </div>
  );
};

export default React.memo(RenderQA);
