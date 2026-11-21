// A run, task, step or approval status, a recovery reason or a replay risk as
// the server sends it, translated (the status.* keys; a recovery reason can be
// a replay risk, so they share them). A value without a key reads as words.
export const formatStatusLabel = (status, t) => {
  const value = String(status ?? "pending");
  const key = `status.${value}`;
  const label = t(key);

  if (label !== key) {
    return label;
  }

  const words = value.replace(/_/g, " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
};

// A capability_call step is labelled with its Capability, like the step whose
// approval queued it ("Web Search" twice): this tells the call apart.
export const formatStepLabel = ({ label, type } = {}, t) => {
  const name = label || type || t("sidebar.step");

  return type === "capability_call"
    ? t("workbench.capabilityCall", { label: name })
    : name;
};

// The two things an operator can do with a run from the recovery panel.
// (There is no "resume step": the server never runs a step on its own, and it
// continues an interrupted graph by itself at startup.)
const RECOVERY_ACTION_LABEL_KEYS = {
  cancel: "common.cancel",
  retry_failed_step: "sidebar.retryFailedStep",
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

export const formatRecoveryActionLabel = (actionType, t) =>
  RECOVERY_ACTION_LABEL_KEYS[actionType]
    ? t(RECOVERY_ACTION_LABEL_KEYS[actionType])
    : String(actionType ?? t("sidebar.recoveryAction")).replace(/_/g, " ");

export const getRecoveryActionSuccessMessage = (action, t) =>
  t(action === "cancel" ? "app.runCanceled" : "app.recoveryActionDone");
