import { formatStatusLabel } from "./workbenchFormatters";

export const formatAgentMode = (mode, t) => {
  if (!mode) {
    return t("trace.agent");
  }

  return mode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" + ");
};

// A phase or gap type as the server names it, in words.
export const formatTraceStatus = (status, t) => {
  if (!status) {
    return t("trace.completed");
  }

  return status.replace(/_/g, " ");
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

export const formatDetailValue = (value, t) => {
  if (typeof value === "boolean") {
    return t(value ? "common.yes" : "common.no");
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : t("common.notAvailable");
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const primitiveValues = value.filter(
      (item) => ["string", "number", "boolean"].includes(typeof item)
    );

    return primitiveValues.length > 0
      ? primitiveValues.map((item) => formatDetailValue(item, t)).join(", ")
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

export const getSkillLabel = (skill = {}, t) =>
  skill.label ?? getSkillId(skill) ?? t("trace.unknownSkill");

export const formatSkillRef = (skill = {}, t) => {
  const label = getSkillLabel(skill, t);
  const version = formatMaybeVersion(getSkillVersion(skill));

  return `${label}${version}`;
};

export const formatSkillMetricCopy = (skill = {}, t) => {
  const parts = [
    skill.status ? formatStatusLabel(skill.status, t) : null,
    Number.isFinite(skill.attempts)
      ? t("trace.attemptCount", { count: skill.attempts })
      : null,
    Number.isFinite(skill.retryCount) && skill.retryCount > 0
      ? t("trace.retryCount", { count: skill.retryCount })
      : null,
    Number.isFinite(skill.followUpCount) && skill.followUpCount > 0
      ? t("trace.followUpCount", { count: skill.followUpCount })
      : null,
    Number.isFinite(skill.citationCount)
      ? t("trace.citationCount", { count: skill.citationCount })
      : null,
    formatDuration(skill.totalDurationMs ?? skill.durationMs),
    Number.isFinite(skill.budgetUsed) || Number.isFinite(skill.budgetLimit)
      ? t("trace.budgetUsed", {
          value: formatBudgetCounter(skill.budgetUsed, skill.budgetLimit),
        })
      : null,
  ].filter(Boolean);

  return parts.join(" · ");
};

export const formatGapType = (gap = {}, t) =>
  formatTraceStatus(String(gap.type ?? "evidence_gap"), t).replace(/\b\w/g, (letter) =>
    letter.toUpperCase()
  );

export const getGapTitle = (gap = {}, index, t) =>
  gap.claim ?? gap.message ?? gap.reason ?? `${formatGapType(gap, t)} ${index + 1}`;

export const formatMissingAnchors = (anchors, t) =>
  Array.isArray(anchors) && anchors.length > 0
    ? t("trace.missingAnchors", { anchors: anchors.join(", ") })
    : null;

export const getGapCopy = (gap = {}, t) => {
  const parts = [
    formatGapType(gap, t),
    gap.skillId
      ? `${gap.skillId}${formatMaybeVersion(gap.skillVersion)}`
      : null,
    gap.phase ? t("trace.phase", { phase: formatTraceStatus(gap.phase, t) }) : null,
    formatMissingAnchors(gap.missingAnchors, t),
  ].filter(Boolean);

  return parts.join(" · ");
};

// The query list's line under each query: the query, its skill, its phase.
export const formatQueryCopy = (query = {}, t) =>
  [
    query.query,
    query.skillId
      ? `${query.skillId}${formatMaybeVersion(query.skillVersion)}`
      : null,
    query.phase
      ? t("trace.phase", { phase: formatTraceStatus(String(query.phase), t) })
      : null,
    query.primary ? t("trace.primary") : null,
  ]
    .filter(Boolean)
    .join(" · ");

const BUDGET_ITEMS = [
  {
    labelKey: "trace.budgetArxiv",
    usedKey: "arxivPaperFetches",
    limitKey: "maxArxivPaperFetches",
  },
  {
    labelKey: "trace.budgetDocRag",
    usedKey: "documentRagCalls",
    limitKey: "maxDocumentRagCalls",
  },
  {
    labelKey: "trace.budgetWeb",
    usedKey: "webSearchCalls",
    limitKey: "maxWebSearchCalls",
  },
  {
    labelKey: "trace.budgetResearch",
    usedKey: "researchQuestions",
    limitKey: "maxResearchQuestions",
  },
  {
    labelKey: "trace.budgetCustom",
    usedKey: "customSkillCalls",
    limitKey: "maxCustomSkillCalls",
  },
  {
    labelKey: "trace.budgetTrace",
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

const TraceBudgetSnapshot = ({ budget, t }) => {
  if (!isPlainObject(budget)) {
    return null;
  }

  const limits = isPlainObject(budget.limits) ? budget.limits : {};
  const used = isPlainObject(budget.used) ? budget.used : {};

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">{t("trace.budget")}</div>
      <div className="archive-agent-budget-grid">
        {BUDGET_ITEMS.map((item) => (
          <div key={item.usedKey} className="archive-agent-budget-item">
            <span>{t(item.labelKey)}</span>
            <strong>{formatBudgetCounter(used[item.usedKey], limits[item.limitKey])}</strong>
          </div>
        ))}
        {budget.traceTruncated ? (
          <div className="archive-agent-budget-item is-warning">
            <span>{t("trace.budgetTrace")}</span>
            <strong>{t("trace.capped")}</strong>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const TraceActionList = ({ label, items, getTitle, getCopy = () => null }) => {
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

export const TraceSkillList = ({ label, skills, t }) => {
  if (!Array.isArray(skills) || skills.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={label}
      items={skills}
      getTitle={(skill) => formatSkillRef(skill, t)}
      getCopy={(skill) => formatSkillMetricCopy(skill, t)}
    />
  );
};

export const TraceRetrievalQueries = ({ queries, t }) => {
  if (!Array.isArray(queries) || queries.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={t("trace.retrievalQueries")}
      items={queries}
      getTitle={(query, index) =>
        query.label ?? query.queryId ?? query.id ?? t("trace.query", { number: index + 1 })
      }
      getCopy={(query) => formatQueryCopy(query, t)}
    />
  );
};

export const TraceGapList = ({ gaps, t }) => {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={t("trace.evidenceGaps")}
      items={gaps}
      getTitle={(gap, index) => getGapTitle(gap, index, t)}
      getCopy={(gap) => getGapCopy(gap, t)}
    />
  );
};

export const TraceRemovedClaims = ({ claims, t }) => {
  if (!Array.isArray(claims) || claims.length === 0) {
    return null;
  }

  return (
    <TraceActionList
      label={t("trace.removedClaims")}
      items={claims}
      getTitle={(claim, index) => String(claim ?? t("trace.claim", { number: index + 1 }))}
    />
  );
};

const TraceReasonList = ({ reasons, t }) => {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">{t("trace.reasons")}</div>
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

const TraceClaimSupport = ({ claimSupport, t }) => {
  if (!isPlainObject(claimSupport)) {
    return null;
  }

  const unsupportedClaims = Array.isArray(claimSupport.claims)
    ? claimSupport.claims.filter((claim) => claim && !claim.supported)
    : [];

  return (
    <div className="archive-agent-detail-section">
      <div className="archive-agent-detail-caption">{t("trace.claims")}</div>
      <TraceDetailRows
        rows={[
          {
            label: t("trace.supported"),
            value: formatDetailValue(claimSupport.supportedClaimCount, t),
          },
          {
            label: t("trace.unsupported"),
            value: formatDetailValue(claimSupport.unsupportedClaimCount, t),
          },
        ]}
      />
      <TraceActionList
        label={t("trace.unsupportedClaims")}
        items={unsupportedClaims}
        getTitle={(claim, index) => claim.text ?? t("trace.claim", { number: index + 1 })}
        getCopy={(claim) => formatMissingAnchors(claim.missingAnchors, t)}
      />
    </div>
  );
};

// The step's own fields, named as the server names them.
const GenericTraceDetail = ({ detail, exclude = [], t }) => {
  const excludedKeys = new Set(exclude);
  const rows = Object.entries(detail)
    .filter(([key]) => !excludedKeys.has(key))
    .map(([key, value]) => ({
      label: formatDetailLabel(key),
      value: formatDetailValue(value, t),
    }))
    .filter(({ value }) => value !== null);

  return <TraceDetailRows rows={rows} />;
};

const AgentTraceDetail = ({ step, t }) => {
  const detail = step?.detail;

  if (!isPlainObject(detail)) {
    return null;
  }

  if (step.type === "plan") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: t("trace.mode"), value: formatAgentMode(detail.mode, t) },
            {
              label: t("trace.documents"),
              value: Array.isArray(detail.docIds)
                ? t("trace.selectedCount", { count: detail.docIds.length })
                : null,
            },
          ]}
        />
        <TraceActionList
          label={t("trace.actions")}
          items={detail.actions}
          getTitle={(action, index) =>
            action.label ?? action.id ?? t("trace.action", { number: index + 1 })
          }
          getCopy={(action) => action.summary}
        />
        <TraceBudgetSnapshot budget={detail.budget} t={t} />
      </div>
    );
  }

  if (step.type === "query_planner") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: t("trace.intent"), value: formatDetailValue(detail.intent, t) },
            { label: t("trace.phaseLabel"), value: formatTraceStatus(detail.phase, t) },
            {
              label: t("trace.topK"),
              value: formatDetailValue(detail.retrievalOptions?.topK, t),
            },
            {
              label: t("trace.topKPerDoc"),
              value: formatDetailValue(detail.retrievalOptions?.topKPerDoc, t),
            },
            {
              label: t("trace.profile"),
              value: formatDetailValue(detail.retrievalOptions?.profile, t),
            },
          ]}
        />
        <TraceRetrievalQueries queries={detail.retrievalQueries} t={t} />
      </div>
    );
  }

  if (step.type === "skill_chain") {
    return (
      <div className="archive-agent-detail">
        <TraceSkillList label={t("trace.chainOrder")} skills={detail.skills} t={t} />
      </div>
    );
  }

  if (step.type === "research_plan") {
    return (
      <div className="archive-agent-detail">
        <TraceActionList
          label={t("trace.questions")}
          items={detail.questions}
          getTitle={(question, index) =>
            question.id ?? t("trace.question", { number: index + 1 })
          }
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
            { label: t("common.citations"), value: formatDetailValue(detail.citations, t) },
            { label: t("trace.abstained"), value: formatDetailValue(detail.abstained, t) },
            { label: t("common.error"), value: formatDetailValue(detail.error, t) },
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
            { label: t("trace.skill"), value: detail.skillId },
            { label: t("trace.version"), value: detail.skillVersion },
            { label: t("trace.duration"), value: formatDuration(detail.durationMs) },
            { label: t("common.citations"), value: formatDetailValue(detail.citations, t) },
            { label: t("trace.abstained"), value: formatDetailValue(detail.abstained, t) },
            {
              label: t("trace.selectedDocs"),
              value: formatDetailValue(detail.selectedDocumentCount, t),
            },
          ]}
        />
        <TraceRetrievalQueries
          queries={
            detail.retrievalPlan?.retrievalQueries ?? detail.retrievalQueries
          }
          t={t}
        />
        <TraceGapList gaps={detail.gaps} t={t} />
        <TracePromptText label={t("trace.skillRequest")} value={prompt} />
      </div>
    );
  }

  if (step.type === "self_check") {
    return (
      <div className="archive-agent-detail">
        <div className="archive-agent-budget-grid">
          <div className="archive-agent-budget-item">
            <span>{t("common.citations")}</span>
            <strong>
              {formatBudgetCounter(
                detail.citationCount,
                detail.requiredCitationCount
              )}
            </strong>
          </div>
          <div className="archive-agent-budget-item">
            <span>{t("trace.docs")}</span>
            <strong>
              {formatBudgetCounter(detail.citedDocCount, detail.requiredDocCoverage)}
            </strong>
          </div>
          <div className="archive-agent-budget-item">
            <span>{t("common.retry")}</span>
            <strong>{formatDetailValue(detail.retryRecommended, t)}</strong>
          </div>
          <div className="archive-agent-budget-item">
            <span>{t("trace.passed")}</span>
            <strong>{formatDetailValue(detail.passed, t)}</strong>
          </div>
        </div>
        <TraceClaimSupport claimSupport={detail.claimSupport} t={t} />
        <TraceReasonList reasons={detail.reasons} t={t} />
      </div>
    );
  }

  if (step.type === "gap_analysis") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: t("trace.skill"), value: detail.skillId },
            { label: t("trace.version"), value: detail.skillVersion },
            {
              label: t("trace.followUp"),
              value: formatDetailValue(detail.followUpRecommended, t),
            },
          ]}
        />
        <TraceGapList gaps={detail.gaps} t={t} />
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
            { label: t("trace.reason"), value: formatDetailValue(detail.reason, t) },
          ]}
        />
        <TraceGapList gaps={detail.gaps} t={t} />
        <TracePromptText
          label={t("trace.clarificationQuestion")}
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
            { label: t("trace.changed"), value: formatDetailValue(detail.changed, t) },
            { label: t("trace.abstained"), value: formatDetailValue(detail.abstained, t) },
          ]}
        />
        <TraceRemovedClaims claims={detail.removedClaims} t={t} />
        <TraceClaimSupport claimSupport={detail.claimSupport} t={t} />
      </div>
    );
  }

  if (step.type === "budget_limit") {
    return (
      <div className="archive-agent-detail">
        <TraceDetailRows
          rows={[
            { label: t("trace.tool"), value: formatDetailValue(detail.tool, t) },
            { label: t("trace.reason"), value: formatDetailValue(detail.reason, t) },
          ]}
        />
      </div>
    );
  }

  if (isPlainObject(detail.budget)) {
    return (
      <div className="archive-agent-detail">
        <GenericTraceDetail detail={detail} exclude={["budget"]} t={t} />
        <TraceBudgetSnapshot budget={detail.budget} t={t} />
      </div>
    );
  }

  return (
    <div className="archive-agent-detail">
      <GenericTraceDetail detail={detail} t={t} />
    </div>
  );
};

export default AgentTraceDetail;
