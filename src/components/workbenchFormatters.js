export const formatTaskStatus = (status) =>
  String(status ?? "pending").replace(/_/g, " ");

// The two things an operator can do with a run from the recovery panel.
// (There is no "resume step": the server never runs a step on its own, and it
// continues an interrupted graph by itself at startup.)
const RECOVERY_ACTION_LABELS = {
  cancel: "Cancel",
  retry_failed_step: "Retry failed step",
};

// The step types the server retries on their own, from its replay matrix
// (server/rag/agent-run-step-replay-safety.js, isStepRetryAllowed;
// workbenchFormatters.test.js holds the two lists together). Every other
// failed step is refused there: the step of a graph node (a custom Skill runs
// only inside its execution graph) and an approval-capable primary step (web
// search, arXiv import). The recovery panel gets its actions from the server;
// the chat's run panel only has the steps, so it asks here before it shows a
// Retry button.
const SELF_RETRYABLE_STEP_TYPES = new Set([
  "capability_call",
  "document_rag",
  "follow_up_retrieval",
  "research_question",
]);

export const listSelfRetryableStepTypes = () => [...SELF_RETRYABLE_STEP_TYPES].sort();

export const isStepRetrySupported = (stepType) =>
  SELF_RETRYABLE_STEP_TYPES.has(String(stepType ?? "").trim().toLowerCase());

export const formatRecoveryActionLabel = (actionType) =>
  RECOVERY_ACTION_LABELS[actionType] ??
  String(actionType ?? "Action").replace(/_/g, " ");

export const getRecoveryActionSuccessMessage = (action) => {
  if (action === "cancel") {
    return "Agent run canceled.";
  }

  return "Agent run recovery action completed.";
};

export const getRecoveryReplaySafetyItems = (recovery) =>
  Array.isArray(recovery?.replaySafety?.steps)
    ? recovery.replaySafety.steps
    : [];

// What replaying a step would risk or lack, as the server's reason codes.
export const formatReplaySafetyReasonCodes = (safety = {}) => {
  const reasonCodes = Array.isArray(safety.reasonCodes)
    ? safety.reasonCodes.filter(Boolean)
    : [];

  return reasonCodes.length > 0
    ? reasonCodes.join(", ")
    : "No reason codes reported";
};
