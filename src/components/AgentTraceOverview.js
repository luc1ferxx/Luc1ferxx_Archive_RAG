import {
  TraceActionList,
  TraceGapList,
  TraceRemovedClaims,
  TraceRetrievalQueries,
  TraceSkillList,
  formatDetailValue,
  formatTraceCount,
} from "./AgentTraceDetail";

const getSkillId = (skill = {}) => skill.skillId ?? skill.id ?? null;

const formatPlannerLabel = (planner = {}) => {
  if (planner.status === "not_run") {
    return "Not run";
  }

  if (planner.fallback) {
    return `${planner.requestedPlannerId ?? "unknown"} -> ${
      planner.selectedPlannerId ?? "unknown"
    }`;
  }

  return planner.selectedPlannerId ?? planner.requestedPlannerId ?? "Unknown";
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
  const executionPlanner = observability.executionPlanner ?? {};
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
  const hasPlanner = Boolean(executionPlanner.status);
  const hasOverview =
    hasPlanner ||
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
          <span>Planner</span>
          <strong title={executionPlanner.fallbackReason ?? undefined}>
            {formatPlannerLabel(executionPlanner)}
          </strong>
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

export default AgentTraceOverview;
