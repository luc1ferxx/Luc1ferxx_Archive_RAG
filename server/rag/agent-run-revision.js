export const AGENT_RUN_REVISION_CONFLICT = "AGENT_RUN_REVISION_CONFLICT";
export const AGENT_RUN_ALREADY_EXISTS = "AGENT_RUN_ALREADY_EXISTS";

export const normalizeAgentRunRevision = (value) => {
  const revision = Number(value);

  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

export const createAgentRunRevisionConflictError = ({
  actualRevision,
  expectedRevision,
  runId,
} = {}) => {
  const error = new Error("Agent run changed while the update was in progress.");

  error.code = AGENT_RUN_REVISION_CONFLICT;
  error.status = 409;
  error.runId = runId;
  error.expectedRevision = normalizeAgentRunRevision(expectedRevision);
  error.actualRevision = normalizeAgentRunRevision(actualRevision);

  return error;
};

export const isAgentRunRevisionConflictError = (error) =>
  error?.code === AGENT_RUN_REVISION_CONFLICT;

export const createAgentRunAlreadyExistsError = ({ runId } = {}) => {
  const error = new Error("Agent run already exists.");

  error.code = AGENT_RUN_ALREADY_EXISTS;
  error.status = 409;
  error.runId = runId;

  return error;
};
