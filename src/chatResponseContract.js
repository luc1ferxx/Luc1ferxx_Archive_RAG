const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const getSkillId = (skill = {}) => skill.skillId ?? skill.id ?? null;

export const getAnswerObservability = (answer = {}) =>
  answer?.agentObservability && typeof answer.agentObservability === "object"
    ? answer.agentObservability
    : {};

export const getAnswerTrace = (answer = {}) => normalizeArray(answer?.agentTrace);

export const getAnswerWorkingMemory = (answer = {}) => {
  const observability = getAnswerObservability(answer);

  return answer?.agentWorkingMemory ?? observability.workingMemory ?? {};
};

export const getObservedSelectedSkills = ({ answer }) => {
  const observability = getAnswerObservability(answer);
  const selectedSkills = normalizeArray(observability.selectedSkills);
  const agentSkills = normalizeArray(answer?.agentSkills);
  const observations = normalizeArray(observability.skills);
  const observationById = new Map(
    observations.map((skill) => [getSkillId(skill), skill])
  );
  const sourceSkills = selectedSkills.length > 0 ? selectedSkills : agentSkills;

  return sourceSkills.map((skill) => ({
    ...skill,
    ...(observationById.get(getSkillId(skill)) ?? {}),
  }));
};

export const getAnswerTraceOverview = (answer = {}) => {
  const observability = getAnswerObservability(answer);
  const workingMemory = getAnswerWorkingMemory(answer);
  const agentTrace = getAnswerTrace(answer);
  const finalizerStep =
    agentTrace.find((step) => step.type === "answer_finalizer") ?? null;
  const loop = observability.executionLoop ?? {};
  const unresolvedGaps = normalizeArray(workingMemory.unresolvedGaps);

  return {
    checkedQueries: normalizeArray(workingMemory.checkedQueries),
    executionPlanner: observability.executionPlanner ?? {},
    loop,
    removedClaims: normalizeArray(finalizerStep?.detail?.removedClaims),
    resolvedGaps: normalizeArray(workingMemory.resolvedGaps),
    selectedSkills: getObservedSelectedSkills({ answer }),
    skillChain: normalizeArray(observability.skillChain),
    unsupportedClaims: normalizeArray(workingMemory.unsupportedClaims),
    allGaps:
      unresolvedGaps.length > 0 ? unresolvedGaps : normalizeArray(loop.gaps),
  };
};
