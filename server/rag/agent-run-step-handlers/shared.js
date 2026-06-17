export const normalizeText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

export const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

export const toArray = (value) => (Array.isArray(value) ? value : []);

export const normalizeTextList = (value) =>
  toArray(value).map(normalizeText).filter(Boolean);

export const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

export const buildErrorPayload = (error, fallbackMessage) => ({
  message: serializeError(error, fallbackMessage),
  name: error?.name ?? "Error",
});

export const fail = (message, status = 409) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

const toTraceStatus = (status) => (status === "paused" ? "needs_input" : status);

export const getStepType = (step = {}) =>
  normalizeText(step.type).toLowerCase();

export const buildAgentTraceFromRunSteps = (steps = []) =>
  toArray(steps).map((runStep) => ({
    id: runStep.traceStepId || runStep.id,
    type: runStep.type,
    label: runStep.label,
    status: toTraceStatus(runStep.status),
    summary: runStep.summary,
    detail: {
      ...(runStep.detail ?? {}),
      attempt: runStep.attempt,
      kind: runStep.kind,
      retryOfStepId: runStep.retryOfStepId || null,
    },
  }));

export const getStepInput = (step = {}) => {
  const detail = normalizeRecord(step.detail, {});

  return (
    normalizeRecord(step.input, null) ??
    normalizeRecord(detail.input, null) ??
    normalizeRecord(detail.capabilityInput, null) ??
    null
  );
};
