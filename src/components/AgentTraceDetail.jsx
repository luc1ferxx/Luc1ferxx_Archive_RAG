export const formatAgentMode = (mode) => {
  if (!mode) {
    return "Agent";
  }

  return mode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" + ");
};

export const formatTraceStatus = (status) => {
  if (!status) {
    return "completed";
  }

  return status.replace(/_/g, " ");
};

export const formatTraceCount = (count, singular, plural = `${singular}s`) => {
  const safeCount = Number.isFinite(count) ? count : 0;

  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
};

export const formatDuration = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return `${Math.round(parsed)} ms`;
};

export const formatMaybeVersion = (version) => {
  const normalizedVersion = String(version ?? "").trim();

  return normalizedVersion ? `@${normalizedVersion}` : "";
};

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const formatDetailLabel = (label) =>
  label
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());

export const formatDetailValue = (value) => {
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

export const formatBudgetCounter = (usedValue, limitValue) => {
  const used = Number.isFinite(usedValue) ? usedValue : 0;

  if (!Number.isFinite(limitValue)) {
    return String(used);
  }

  return `${used} / ${limitValue}`;
};

export const getSkillId = (skill = {}) => skill.skillId ?? skill.id ?? null;

export const getSkillVersion = (skill = {}) =>
  skill.skillVersion ?? skill.version ?? null;

export const getSkillLabel = (skill = {}) =>
  skill.label ?? getSkillId(skill) ?? "Unknown skill";

export const formatSkillRef = (skill = {}) => {
  const label = getSkillLabel(skill);
  const version = formatMaybeVersion(getSkillVersion(skill));

  return `${label}${version}`;
};

export const formatSkillMetricCopy = (skill = {}) => {
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

export const formatGapType = (gap = {}) =>
  formatTraceStatus(String(gap.type ?? "evidence_gap")).replace(/\b\w/g, (letter) =>
    letter.toUpperCase()
  );

export const getGapTitle = (gap = {}, index) =>
  gap.claim ?? gap.message ?? gap.reason ?? `${formatGapType(gap)} ${index + 1}`;

export const getGapCopy = (gap = {}) => {
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

const BUDGET_ITEMS = [
  {
    label: "arXiv",
    usedKey: "arxivPaperFetches",
    limitKey: "maxArxivPaperFetches",
  },
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

export const TraceDetailRows = ({ rows }) => {
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

export const TraceActionList = ({
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

export const TraceSkillList = ({ label = "Selected skills", skills }) => {
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

export const TraceRetrievalQueries = ({
  label = "Retrieval queries",
  queries,
}) => {
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

export const TraceGapList = ({ label = "Evidence gaps", gaps }) => {
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

export const TraceRemovedClaims = ({ claims }) => {
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

export default AgentTraceDetail;
