const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const AGENT_RUN_STEP_STATUSES = Object.freeze({
  completed: "completed",
  failed: "failed",
  paused: "paused",
  pending: "pending",
  running: "running",
  skipped: "skipped",
});

export const AGENT_RUN_STEP_KINDS = Object.freeze({
  approvalGate: "approval_gate",
  capabilityCall: "capability_call",
  decision: "decision",
  finalAnswer: "final_answer",
  observation: "observation",
  plan: "plan",
  toolCall: "tool_call",
});

const VALID_STEP_STATUSES = new Set(Object.values(AGENT_RUN_STEP_STATUSES));
const VALID_STEP_KINDS = new Set(Object.values(AGENT_RUN_STEP_KINDS));

const AGENT_RUN_STEP_STATUS_TRANSITIONS = Object.freeze({
  [AGENT_RUN_STEP_STATUSES.pending]: new Set([
    AGENT_RUN_STEP_STATUSES.failed,
    AGENT_RUN_STEP_STATUSES.paused,
    AGENT_RUN_STEP_STATUSES.pending,
    AGENT_RUN_STEP_STATUSES.running,
    AGENT_RUN_STEP_STATUSES.skipped,
  ]),
  [AGENT_RUN_STEP_STATUSES.running]: new Set([
    AGENT_RUN_STEP_STATUSES.completed,
    AGENT_RUN_STEP_STATUSES.failed,
    AGENT_RUN_STEP_STATUSES.paused,
    AGENT_RUN_STEP_STATUSES.running,
  ]),
  [AGENT_RUN_STEP_STATUSES.paused]: new Set([
    AGENT_RUN_STEP_STATUSES.completed,
    AGENT_RUN_STEP_STATUSES.failed,
    AGENT_RUN_STEP_STATUSES.paused,
    AGENT_RUN_STEP_STATUSES.running,
    AGENT_RUN_STEP_STATUSES.skipped,
  ]),
  [AGENT_RUN_STEP_STATUSES.completed]: new Set([
    AGENT_RUN_STEP_STATUSES.completed,
  ]),
  [AGENT_RUN_STEP_STATUSES.failed]: new Set([
    AGENT_RUN_STEP_STATUSES.failed,
  ]),
  [AGENT_RUN_STEP_STATUSES.skipped]: new Set([
    AGENT_RUN_STEP_STATUSES.skipped,
  ]),
});

export const normalizeAgentRunStepStatus = (status) => {
  const normalizedStatus = normalizeText(status).toLowerCase();

  if (normalizedStatus === "needs_input") {
    return AGENT_RUN_STEP_STATUSES.paused;
  }

  return VALID_STEP_STATUSES.has(normalizedStatus)
    ? normalizedStatus
    : AGENT_RUN_STEP_STATUSES.pending;
};

export const isKnownAgentRunStepStatus = (status) => {
  const normalizedStatus = normalizeText(status).toLowerCase();

  return (
    normalizedStatus === "needs_input" ||
    VALID_STEP_STATUSES.has(normalizedStatus)
  );
};

const buildStepStatusError = (message, status = 409) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

export const assertAgentRunStepStatusTransition = ({ from, to } = {}) => {
  const fromStatus = normalizeAgentRunStepStatus(from);
  const toStatus = normalizeAgentRunStepStatus(to);
  const allowedStatuses =
    AGENT_RUN_STEP_STATUS_TRANSITIONS[fromStatus] ?? new Set();

  if (!allowedStatuses.has(toStatus)) {
    throw buildStepStatusError(
      `Invalid agent run step status transition: ${fromStatus} -> ${toStatus}.`
    );
  }
};

export const normalizeAgentRunStepKind = (kind) => {
  const normalizedKind = normalizeText(kind).toLowerCase();

  return VALID_STEP_KINDS.has(normalizedKind)
    ? normalizedKind
    : AGENT_RUN_STEP_KINDS.observation;
};

export const createUnsupportedAgentRunStepStatusError = (status) =>
  buildStepStatusError(`Unsupported agent run step status: ${status}.`, 400);
