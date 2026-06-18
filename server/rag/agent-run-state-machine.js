const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const AGENT_RUN_STATUSES = Object.freeze({
  canceled: "canceled",
  completed: "completed",
  failed: "failed",
  running: "running",
  waitingForUser: "waiting_for_user",
});

const VALID_AGENT_RUN_STATUSES = new Set(Object.values(AGENT_RUN_STATUSES));
const INITIAL_AGENT_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.running,
  AGENT_RUN_STATUSES.waitingForUser,
]);
const RETRYABLE_AGENT_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.completed,
  AGENT_RUN_STATUSES.failed,
]);
const AGENT_RUN_STATUS_TRANSITIONS = Object.freeze({
  [AGENT_RUN_STATUSES.running]: new Set([
    AGENT_RUN_STATUSES.canceled,
    AGENT_RUN_STATUSES.completed,
    AGENT_RUN_STATUSES.failed,
    AGENT_RUN_STATUSES.running,
    AGENT_RUN_STATUSES.waitingForUser,
  ]),
  [AGENT_RUN_STATUSES.waitingForUser]: new Set([
    AGENT_RUN_STATUSES.canceled,
    AGENT_RUN_STATUSES.completed,
    AGENT_RUN_STATUSES.failed,
    AGENT_RUN_STATUSES.running,
    AGENT_RUN_STATUSES.waitingForUser,
  ]),
  [AGENT_RUN_STATUSES.canceled]: new Set([
    AGENT_RUN_STATUSES.canceled,
  ]),
  [AGENT_RUN_STATUSES.completed]: new Set([
    AGENT_RUN_STATUSES.completed,
  ]),
  [AGENT_RUN_STATUSES.failed]: new Set([
    AGENT_RUN_STATUSES.failed,
  ]),
});

export const normalizeAgentRunStatus = (status) => {
  const normalizedStatus = normalizeText(status);

  return VALID_AGENT_RUN_STATUSES.has(normalizedStatus)
    ? normalizedStatus
    : AGENT_RUN_STATUSES.running;
};

export const isKnownAgentRunStatus = (status) =>
  VALID_AGENT_RUN_STATUSES.has(normalizeText(status));

export const isRetryableAgentRunStatus = (status) =>
  RETRYABLE_AGENT_RUN_STATUSES.has(normalizeAgentRunStatus(status));

const buildRunStatusError = (message, status = 409) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

export const assertKnownAgentRunStatus = (status) => {
  if (!isKnownAgentRunStatus(status)) {
    throw buildRunStatusError(`Unsupported agent run status: ${status}.`, 400);
  }

  return normalizeAgentRunStatus(status);
};

export const assertInitialAgentRunStatus = (status) => {
  const normalizedStatus = assertKnownAgentRunStatus(status);

  if (!INITIAL_AGENT_RUN_STATUSES.has(normalizedStatus)) {
    throw buildRunStatusError(
      `Invalid initial agent run status: ${normalizedStatus}.`,
      400
    );
  }

  return normalizedStatus;
};

export const assertAgentRunStatusTransition = ({
  allowRetryTransition = false,
  from,
  to,
} = {}) => {
  const fromStatus = assertKnownAgentRunStatus(from);
  const toStatus = assertKnownAgentRunStatus(to);
  const allowedStatuses = AGENT_RUN_STATUS_TRANSITIONS[fromStatus] ?? new Set();

  if (
    allowRetryTransition &&
    isRetryableAgentRunStatus(fromStatus) &&
    toStatus === AGENT_RUN_STATUSES.running
  ) {
    return toStatus;
  }

  if (!allowedStatuses.has(toStatus)) {
    throw buildRunStatusError(
      `Invalid agent run status transition: ${fromStatus} -> ${toStatus}.`
    );
  }

  return toStatus;
};
