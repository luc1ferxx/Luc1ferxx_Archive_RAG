export const normalizeArray = (value) => (Array.isArray(value) ? value : []);

export const isPlainObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const getChatResponseBody = (responseOrBody = {}) => {
  if (!isPlainObject(responseOrBody)) {
    return {};
  }

  return isPlainObject(responseOrBody.body) ? responseOrBody.body : responseOrBody;
};

export const getAgentTrace = (responseOrBody = {}) =>
  normalizeArray(getChatResponseBody(responseOrBody).agentTrace);

export const getTraceTypes = (responseOrBody = {}) =>
  getAgentTrace(responseOrBody).map((step) => step.type);

export const getTraceSteps = (responseOrBody = {}, type) =>
  getAgentTrace(responseOrBody).filter((step) => step.type === type);

export const hasTraceStep = (responseOrBody = {}, type) =>
  getTraceSteps(responseOrBody, type).length > 0;

export const getAgentObservability = (responseOrBody = {}) => {
  const body = getChatResponseBody(responseOrBody);

  return isPlainObject(body.agentObservability) ? body.agentObservability : {};
};

export const hasAgentObservability = (responseOrBody = {}) =>
  isPlainObject(getChatResponseBody(responseOrBody).agentObservability);

export const getAgentMode = (responseOrBody = {}) => {
  const body = getChatResponseBody(responseOrBody);
  const observability = getAgentObservability(responseOrBody);

  return body.agentMode ?? observability.agentMode ?? null;
};

export const getExecutionPlanner = (responseOrBody = {}) => {
  const observability = getAgentObservability(responseOrBody);

  return isPlainObject(observability.executionPlanner)
    ? observability.executionPlanner
    : null;
};

export const getIntentPlanner = (responseOrBody = {}) => {
  const observability = getAgentObservability(responseOrBody);

  return isPlainObject(observability.intentPlanner)
    ? observability.intentPlanner
    : null;
};

export const getObservedSkills = (responseOrBody = {}) =>
  normalizeArray(getAgentObservability(responseOrBody).skills);

export const getSelectedSkills = (responseOrBody = {}) =>
  normalizeArray(getAgentObservability(responseOrBody).selectedSkills);

export const getSelectedSkillIds = (responseOrBody = {}) =>
  getSelectedSkills(responseOrBody).map((skill) => skill.skillId);

export const getSkillChain = (responseOrBody = {}) =>
  normalizeArray(getAgentObservability(responseOrBody).skillChain);

export const getSkillChainIds = (responseOrBody = {}) =>
  getSkillChain(responseOrBody).map((skill) => skill.skillId);

export const getSkillRuns = (responseOrBody = {}) =>
  normalizeArray(getAgentObservability(responseOrBody).runs);

export const getExecutionLoop = (responseOrBody = {}) =>
  getAgentObservability(responseOrBody).executionLoop ?? {};

export const getBudget = (responseOrBody = {}) =>
  getAgentObservability(responseOrBody).budget ?? null;

export const getClarification = (responseOrBody = {}) =>
  getChatResponseBody(responseOrBody).clarification ?? null;

export const getAgentWorkingMemory = (responseOrBody = {}) =>
  getChatResponseBody(responseOrBody).agentWorkingMemory ?? {};

export const getObservedSkill = (responseOrBody = {}, skillId) =>
  getObservedSkills(responseOrBody).find((skill) => skill.skillId === skillId) ??
  null;

export const getRunPhases = (responseOrBody = {}, skillId = null) =>
  getSkillRuns(responseOrBody)
    .filter((run) => !skillId || run.skillId === skillId)
    .map((run) => run.phase);

export const buildChatResponseSummary = ({ response, telemetry = {} } = {}) => {
  const body = getChatResponseBody(response);
  const workingMemory = getAgentWorkingMemory(response);

  return {
    status: response?.status ?? null,
    agentMode: body.agentMode ?? null,
    traceTypes: getTraceTypes(response),
    agentSkills: body.agentSkills ?? [],
    selectedSkills: getSelectedSkills(response),
    skillChain: getSkillChain(response),
    executionLoop: getAgentObservability(response).executionLoop ?? null,
    clarification: getClarification(response),
    budget: getBudget(response),
    workingMemory: {
      checkedQueryCount: normalizeArray(workingMemory.checkedQueries).length,
      unresolvedGapCount: normalizeArray(workingMemory.unresolvedGaps).length,
      resolvedGapCount: normalizeArray(workingMemory.resolvedGaps).length,
      unsupportedClaimCount: normalizeArray(workingMemory.unsupportedClaims).length,
    },
    telemetry: {
      chatCallCount: normalizeArray(telemetry.chatCalls).length,
      listDocumentCallCount: normalizeArray(telemetry.listDocumentScopes).length,
    },
  };
};

export const buildPlannerResponseSummary = ({ response, telemetry = {} } = {}) => {
  const body = getChatResponseBody(response);

  return {
    agentMode: body.agentMode ?? null,
    agentSkills: body.agentSkills ?? [],
    intentPlanner: getIntentPlanner(response),
    planner: getExecutionPlanner(response),
    selectedSkills: getSelectedSkills(response),
    skillChain: getSkillChain(response),
    status: response?.status ?? null,
    telemetry: {
      chatCallCount: normalizeArray(telemetry.chatCalls).length,
      listDocumentCallCount: normalizeArray(telemetry.listDocumentScopes).length,
    },
    traceTypes: getTraceTypes(response),
  };
};
