export const formatTaskStatus = (status) =>
  String(status ?? "pending").replace(/_/g, " ");

// The two things an operator can do with a run from the recovery panel.
// (There is no "resume step": the server never runs a step on its own, and it
// continues an interrupted graph by itself at startup.)
const RECOVERY_ACTION_LABELS = {
  cancel: "Cancel",
  retry_failed_step: "Retry failed step",
};

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
