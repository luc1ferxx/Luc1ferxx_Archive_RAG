export const formatTaskStatus = (status) =>
  String(status ?? "pending").replace(/_/g, " ");

const RECOVERY_ACTION_LABELS = {
  cancel: "Cancel",
  resume_from_step: "Resume step",
  retry_failed_step: "Retry failed step",
};

export const formatRecoveryActionLabel = (actionType) =>
  RECOVERY_ACTION_LABELS[actionType] ??
  String(actionType ?? "Action").replace(/_/g, " ");

export const getRecoveryActionSuccessMessage = (action) => {
  if (action === "cancel") {
    return "Agent run canceled.";
  }

  if (action === "resume_from_step") {
    return "Agent run resumed.";
  }

  return "Agent run recovery action completed.";
};

export const getRecoveryReplaySafetyItems = (recovery) =>
  Array.isArray(recovery?.replaySafety?.steps)
    ? recovery.replaySafety.steps
    : [];

export const formatReplaySafetyDecision = (safety = {}) => {
  if (safety.canAutoReplay === true) {
    return "Auto replay allowed";
  }

  if (safety.canAutoReplay === false) {
    return "Auto replay blocked";
  }

  return "Auto replay not reported";
};

export const formatReplaySafetyReasonCodes = (safety = {}) => {
  const reasonCodes = Array.isArray(safety.reasonCodes)
    ? safety.reasonCodes.filter(Boolean)
    : [];

  return reasonCodes.length > 0
    ? reasonCodes.join(", ")
    : "No reason codes reported";
};

export const formatReplaySafetyCodeLine = (safety = {}) => {
  const decision = formatReplaySafetyDecision(safety);
  const reasonCodes = formatReplaySafetyReasonCodes(safety);

  return reasonCodes === "No reason codes reported"
    ? decision
    : `${decision}: ${reasonCodes}`;
};
