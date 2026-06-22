const MAX_LIST_ITEMS = 8;
const MAX_TEXT_LENGTH = 300;

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const uniqueTexts = (values = []) => {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = normalizeText(value);

    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    result.push(text);
  }

  return result.slice(0, MAX_LIST_ITEMS);
};

const normalizeStep = (step = {}) => {
  const question = normalizeText(step.question);
  const answer = normalizeText(step.answer);

  if (!question && !answer) {
    return null;
  }

  return {
    agentMode: normalizeText(step.agentMode, 80),
    answer,
    question,
  };
};

const normalizeFailedReason = (reason = {}) => {
  const message = normalizeText(reason.message ?? reason.reason);

  if (!message) {
    return null;
  }

  return {
    agentMode: normalizeText(reason.agentMode, 80),
    message,
    question: normalizeText(reason.question),
    responseStatus: Number.isFinite(Number(reason.responseStatus))
      ? Number(reason.responseStatus)
      : null,
  };
};

export const buildAgentTaskPlanningContext = (memory = {}) => {
  const normalizedMemory = normalizeRecord(memory);

  return {
    completedSteps: toArray(normalizedMemory.completedSteps)
      .map(normalizeStep)
      .filter(Boolean)
      .slice(-MAX_LIST_ITEMS),
    evidencePolicy: "planning_context_only",
    failedReasons: toArray(normalizedMemory.failedReasons)
      .map(normalizeFailedReason)
      .filter(Boolean)
      .slice(-MAX_LIST_ITEMS),
    goal: normalizeText(normalizedMemory.goal),
    nextCandidates: uniqueTexts(normalizedMemory.nextCandidates),
    userPreferences: uniqueTexts(normalizedMemory.userPreferences),
  };
};

const getAgentTaskControl = (body = {}) => normalizeRecord(body.agentTask, null);

const buildCompletedStep = ({ body = {}, question, responseStatus = 200 } = {}) => {
  if (body.clarification?.needed === true || responseStatus >= 400) {
    return null;
  }

  return normalizeStep({
    agentMode: body.agentMode,
    answer: body.agentAnswer,
    question,
  });
};

const buildFailedReason = ({ body = {}, question, responseStatus } = {}) => {
  if (responseStatus < 400) {
    return null;
  }

  return normalizeFailedReason({
    agentMode: body.agentMode,
    message: body.error ?? body.errors?.rag ?? body.errors?.mcp ?? "Agent task failed.",
    question,
    responseStatus,
  });
};

export const updateAgentTaskMemory = ({
  body = {},
  memory = {},
  question = "",
  responseStatus = 200,
} = {}) => {
  const taskControl = getAgentTaskControl(body);
  const previousMemory = buildAgentTaskPlanningContext(memory);
  const completedStep = buildCompletedStep({
    body,
    question,
    responseStatus,
  });
  const failedReason = buildFailedReason({
    body,
    question,
    responseStatus,
  });
  const nextCandidates = uniqueTexts([
    ...previousMemory.nextCandidates,
    ...toArray(taskControl?.nextCandidates),
    taskControl?.nextQuestion,
  ]);
  const userPreferences = uniqueTexts([
    ...previousMemory.userPreferences,
    ...toArray(taskControl?.userPreferences),
  ]);

  return buildAgentTaskPlanningContext({
    ...previousMemory,
    completedSteps: completedStep
      ? [...previousMemory.completedSteps, completedStep]
      : previousMemory.completedSteps,
    failedReasons: failedReason
      ? [...previousMemory.failedReasons, failedReason]
      : previousMemory.failedReasons,
    nextCandidates,
    userPreferences,
  });
};
