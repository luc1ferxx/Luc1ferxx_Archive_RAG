import React, { useState } from "react";
import { Spin } from "antd";

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

const formatTraceCount = (count, singular, plural = `${singular}s`) => {
  const safeCount = Number.isFinite(count) ? count : 0;

  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
};

const formatDuration = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return `${Math.round(parsed)} ms`;
};

const formatMaybeVersion = (version) => {
  const normalizedVersion = String(version ?? "").trim();

  return normalizedVersion ? `@${normalizedVersion}` : "";
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

const formatEvidenceScore = (value) =>
  typeof value === "number" ? value.toFixed(2) : "N/A";

const getSkillId = (skill = {}) => skill.skillId ?? skill.id ?? null;

const getSkillVersion = (skill = {}) => skill.skillVersion ?? skill.version ?? null;

const getSkillLabel = (skill = {}) =>
  skill.label ?? getSkillId(skill) ?? "Unknown skill";

const formatSkillRef = (skill = {}) => {
  const label = getSkillLabel(skill);
  const version = formatMaybeVersion(getSkillVersion(skill));

  return `${label}${version}`;
};

const formatSkillMetricCopy = (skill = {}) => {
  const parts = [
    skill.status ? formatTraceStatus(skill.status) : null,
    Number.isFinite(skill.attempts)
      ? formatTraceCount(skill.attempts, "attempt")
      : null,
    Number.isFinite(skill.retryCount) && skill.retryCount > 0
      ? formatTraceCount(skill.retryCount, "retry", "retries")
      : null,
    Number.isFinite(skill.followUpCount) && skill.followUpCount > 0
      ? formatTraceCount(skill.followUpCount, "follow-up")
      : null,
    Number.isFinite(skill.citationCount)
      ? formatTraceCount(skill.citationCount, "citation")
      : null,
    formatDuration(skill.totalDurationMs ?? skill.durationMs),
    Number.isFinite(skill.budgetUsed) || Number.isFinite(skill.budgetLimit)
      ? `budget ${formatBudgetCounter(skill.budgetUsed, skill.budgetLimit)}`
      : null,
  ].filter(Boolean);

  return parts.join(" · ");
};

const formatGapType = (gap = {}) =>
  formatTraceStatus(String(gap.type ?? "evidence_gap")).replace(/\b\w/g, (letter) =>
    letter.toUpperCase()
  );

const getGapTitle = (gap = {}, index) =>
  gap.claim ?? gap.message ?? gap.reason ?? `${formatGapType(gap)} ${index + 1}`;

const getGapCopy = (gap = {}) => {
  const anchors = Array.isArray(gap.missingAnchors) && gap.missingAnchors.length > 0
    ? `missing anchors: ${gap.missingAnchors.join(", ")}`
    : null;
  const parts = [
    formatGapType(gap),
    gap.skillId
      ? `${gap.skillId}${formatMaybeVersion(gap.skillVersion)}`
      : null,
    gap.phase ? `phase: ${formatTraceStatus(gap.phase)}` : null,
    anchors,
  ].filter(Boolean);

  return parts.join(" · ");
};

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
    label: "Custom",
    usedKey: "customSkillCalls",
    limitKey: "maxCustomSkillCalls",
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

const TraceActionList = ({
  label,
  items,
  getTitle = (_item, index) => `Item ${index + 1}`,
  getCopy = () => null,
}) => {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">{label}</div>
      <div className="archive-agent-detail-list">
        {items.map((item, index) => (
          <div
            key={item?.id ?? item?.queryId ?? `${label}-${index}`}
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

const TraceSkillList = ({ label = "Selected skills", skills }) => {
  if (!Array.isArray(skills) || skills.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={label}
      items={skills}
      getTitle={(skill) => formatSkillRef(skill)}
      getCopy={(skill) => formatSkillMetricCopy(skill)}
    />
  );
};

const TraceRetrievalQueries = ({ label = "Retrieval queries", queries }) => {
  if (!Array.isArray(queries) || queries.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={label}
      items={queries}
      getTitle={(query, index) =>
        query.label ?? query.queryId ?? query.id ?? `Query ${index + 1}`
      }
      getCopy={(query) =>
        [
          query.query,
          query.skillId
            ? `${query.skillId}${formatMaybeVersion(query.skillVersion)}`
            : null,
          query.phase ? `phase: ${formatTraceStatus(query.phase)}` : null,
          query.primary ? "primary" : null,
        ]
          .filter(Boolean)
          .join(" · ")
      }
    />
  );
};

const TraceGapList = ({ label = "Evidence gaps", gaps }) => {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={label}
      items={gaps}
      getTitle={getGapTitle}
      getCopy={getGapCopy}
    />
  );
};

const TraceRemovedClaims = ({ claims }) => {
  if (!Array.isArray(claims) || claims.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label="Finalizer removed claims"
      items={claims}
      getTitle={(claim, index) => String(claim ?? `Claim ${index + 1}`)}
    />
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

const TracePromptText = ({ label, value }) => {
  if (!value) {
    return null;
  }

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">{label}</div>
      <div className="archive-agent-detail-question">{value}</div>
    </div>
  );
};

const TraceClaimSupport = ({ claimSupport }) => {
  if (!isPlainObject(claimSupport)) {
    return null;
  }

  const unsupportedClaims = Array.isArray(claimSupport.claims)
    ? claimSupport.claims.filter((claim) => claim && !claim.supported)
    : [];

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">Claims</div>
      <TraceDetailRows
        rows={[
          {
            label: "Supported",
            value: formatDetailValue(claimSupport.supportedClaimCount),
          },
          {
            label: "Unsupported",
            value: formatDetailValue(claimSupport.unsupportedClaimCount),
          },
        ]}
      />
      <TraceActionList
        label="Unsupported claims"
        items={unsupportedClaims}
        getTitle={(claim, index) => claim.text ?? `Claim ${index + 1}`}
        getCopy={(claim) =>
          Array.isArray(claim.missingAnchors) && claim.missingAnchors.length > 0
            ? `Missing anchors: ${claim.missingAnchors.join(", ")}`
            : null
        }
      />
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

  if (step.type === "query_planner") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Intent", value: formatDetailValue(detail.intent) },
            { label: "Phase", value: formatTraceStatus(detail.phase) },
            {
              label: "TopK",
              value: formatDetailValue(detail.retrievalOptions?.topK),
            },
            {
              label: "TopK/doc",
              value: formatDetailValue(detail.retrievalOptions?.topKPerDoc),
            },
            {
              label: "Profile",
              value: formatDetailValue(detail.retrievalOptions?.profile),
            },
          ]}
        />
        <TraceRetrievalQueries queries={detail.retrievalQueries} />
      </div>
    );
  }

  if (step.type === "skill_chain") {
    return (
      <div className="archive-agent-detail">
        <TraceSkillList label="Chain order" skills={detail.skills} />
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

  if (
    step.type === "document_rag" ||
    step.type === "custom_skill" ||
    step.type === "follow_up_retrieval"
  ) {
    const prompt =
      detail.riskQuestion ??
      detail.summaryQuestion ??
      detail.timelineQuestion ??
      detail.comparisonQuestion ??
      detail.followUpQuestion ??
      null;

    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Skill", value: detail.skillId },
            { label: "Version", value: detail.skillVersion },
            { label: "Duration", value: formatDuration(detail.durationMs) },
            { label: "Citations", value: formatDetailValue(detail.citations) },
            { label: "Abstained", value: formatDetailValue(detail.abstained) },
            {
              label: "Selected docs",
              value: formatDetailValue(detail.selectedDocumentCount),
            },
            { label: "Chain mode", value: formatDetailValue(detail.chainMode) },
          ]}
        />
        <TraceRetrievalQueries
          queries={
            detail.retrievalPlan?.retrievalQueries ?? detail.retrievalQueries
          }
        />
        <TraceGapList gaps={detail.gaps} />
        <TracePromptText label="Skill request" value={prompt} />
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
        <TraceClaimSupport claimSupport={detail.claimSupport} />
        <TraceReasonList reasons={detail.reasons} />
      </div>
    );
  }

  if (step.type === "gap_analysis") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Skill", value: detail.skillId },
            { label: "Version", value: detail.skillVersion },
            {
              label: "Follow-up",
              value: formatDetailValue(detail.followUpRecommended),
            },
          ]}
        />
        <TraceGapList gaps={detail.gaps} />
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

  if (step.type === "clarification_gate") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Reason", value: formatDetailValue(detail.reason) },
          ]}
        />
        <TraceGapList gaps={detail.gaps} />
        <TracePromptText
          label="Clarification question"
          value={detail.clarificationQuestion}
        />
      </div>
    );
  }

  if (step.type === "answer_finalizer") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: "Changed", value: formatDetailValue(detail.changed) },
            { label: "Abstained", value: formatDetailValue(detail.abstained) },
          ]}
        />
        <TraceRemovedClaims claims={detail.removedClaims} />
        <TraceClaimSupport claimSupport={detail.claimSupport} />
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

const getObservedSelectedSkills = ({ answer }) => {
  const observability = answer?.agentObservability ?? {};
  const selectedSkills = Array.isArray(observability.selectedSkills)
    ? observability.selectedSkills
    : [];
  const agentSkills = Array.isArray(answer?.agentSkills) ? answer.agentSkills : [];
  const observations = Array.isArray(observability.skills)
    ? observability.skills
    : [];
  const observationById = new Map(
    observations.map((skill) => [getSkillId(skill), skill])
  );

  const sourceSkills = selectedSkills.length > 0 ? selectedSkills : agentSkills;

  return sourceSkills.map((skill) => ({
    ...skill,
    ...(observationById.get(getSkillId(skill)) ?? {}),
  }));
};

const AgentTraceOverview = ({ answer, stepCount }) => {
  const observability = answer?.agentObservability ?? {};
  const workingMemory =
    answer?.agentWorkingMemory ?? observability.workingMemory ?? {};
  const selectedSkills = getObservedSelectedSkills({ answer });
  const skillChain = Array.isArray(observability.skillChain)
    ? observability.skillChain
    : [];
  const checkedQueries = Array.isArray(workingMemory.checkedQueries)
    ? workingMemory.checkedQueries
    : [];
  const unresolvedGaps = Array.isArray(workingMemory.unresolvedGaps)
    ? workingMemory.unresolvedGaps
    : [];
  const resolvedGaps = Array.isArray(workingMemory.resolvedGaps)
    ? workingMemory.resolvedGaps
    : [];
  const unsupportedClaims = Array.isArray(workingMemory.unsupportedClaims)
    ? workingMemory.unsupportedClaims
    : [];
  const finalizerStep = Array.isArray(answer?.agentTrace)
    ? answer.agentTrace.find((step) => step.type === "answer_finalizer")
    : null;
  const removedClaims = Array.isArray(finalizerStep?.detail?.removedClaims)
    ? finalizerStep.detail.removedClaims
    : [];
  const loop = observability.executionLoop ?? {};
  const allGaps = unresolvedGaps.length > 0
    ? unresolvedGaps
    : Array.isArray(loop.gaps)
      ? loop.gaps
      : [];
  const hasOverview =
    selectedSkills.length > 0 ||
    skillChain.length > 0 ||
    checkedQueries.length > 0 ||
    allGaps.length > 0 ||
    resolvedGaps.length > 0 ||
    unsupportedClaims.length > 0 ||
    removedClaims.length > 0 ||
    Number.isFinite(loop.followUpsRun);

  if (!hasOverview) {
    return null;
  }

  return (
    <div className="archive-agent-inspector">
      <div className="archive-agent-inspector-head">
        <div className="archive-source-section-label">Agent trace</div>
        <span className="archive-answer-chip archive-answer-chip-agent">
          {formatTraceCount(selectedSkills.length, "skill")}
        </span>
      </div>

      <div className="archive-agent-metric-grid">
        <div className="archive-agent-metric">
          <span>Steps</span>
          <strong>{formatDetailValue(stepCount)}</strong>
        </div>
        <div className="archive-agent-metric">
          <span>Queries</span>
          <strong>{formatDetailValue(checkedQueries.length)}</strong>
        </div>
        <div className="archive-agent-metric">
          <span>Follow-ups</span>
          <strong>{formatDetailValue(loop.followUpsRun)}</strong>
        </div>
        <div className="archive-agent-metric">
          <span>Open gaps</span>
          <strong>{formatDetailValue(allGaps.length)}</strong>
        </div>
        <div className="archive-agent-metric">
          <span>Removed</span>
          <strong>{formatDetailValue(removedClaims.length)}</strong>
        </div>
      </div>

      <TraceSkillList skills={selectedSkills} />
      <TraceSkillList label="Skill chain" skills={skillChain} />
      <TraceRetrievalQueries queries={checkedQueries} />
      <TraceGapList gaps={allGaps} />
      <TraceGapList label="Resolved gaps" gaps={resolvedGaps} />
      <TraceActionList
        label="Unsupported claims"
        items={unsupportedClaims}
        getTitle={(claim, index) => claim.text ?? `Claim ${index + 1}`}
        getCopy={(claim) =>
          Array.isArray(claim.missingAnchors) && claim.missingAnchors.length > 0
            ? `Missing anchors: ${claim.missingAnchors.join(", ")}`
            : null
        }
      />
      <TraceRemovedClaims claims={removedClaims} />
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
