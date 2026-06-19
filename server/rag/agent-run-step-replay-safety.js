const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

export const STEP_REPLAY_APPROVAL_POLICIES = Object.freeze({
  approvedCapabilityGate: "approved_capability_gate",
  capabilityPolicy: "capability_policy",
  none: "none",
});

export const STEP_REPLAY_IDEMPOTENCY = Object.freeze({
  capabilityDefined: "capability_defined",
  dedupedWorkspaceWrite: "deduped_workspace_write",
  externalReadNondeterministic: "external_read_nondeterministic",
  readOnlyDeterministic: "read_only_deterministic",
  readOnlyRag: "read_only_rag",
});

export const STEP_REPLAY_SAFETY_REASON_CODES = Object.freeze({
  externalWrite: "external_write",
  missingInput: "missing_input",
  nonIdempotent: "non_idempotent",
  requiresApproval: "requires_approval",
  unsupportedStepType: "unsupported_step_type",
  unsafeByPolicy: "unsafe_by_policy",
});

const STEP_REPLAY_SAFETY_REASON_DETAILS = Object.freeze({
  [STEP_REPLAY_SAFETY_REASON_CODES.externalWrite]: Object.freeze({
    label: "External write",
    message: "Replay may write to workspace or external state.",
  }),
  [STEP_REPLAY_SAFETY_REASON_CODES.missingInput]: Object.freeze({
    label: "Missing input",
    message: "Replay cannot run without persisted required input.",
  }),
  [STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent]: Object.freeze({
    label: "Non-idempotent",
    message: "Replay may produce nondeterministic or adapter-defined effects.",
  }),
  [STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval]: Object.freeze({
    label: "Requires approval",
    message: "Replay requires an explicit approval or capability policy gate.",
  }),
  [STEP_REPLAY_SAFETY_REASON_CODES.unsupportedStepType]: Object.freeze({
    label: "Unsupported step type",
    message: "Replay policy is not registered for this step type.",
  }),
  [STEP_REPLAY_SAFETY_REASON_CODES.unsafeByPolicy]: Object.freeze({
    label: "Unsafe by policy",
    message: "Replay is not enabled by the registered policy.",
  }),
});

const freezePolicy = (policy) =>
  Object.freeze({
    ...policy,
    optionalInput: Object.freeze(toArray(policy.optionalInput)),
    requiredInput: Object.freeze(toArray(policy.requiredInput)),
    replayActions: Object.freeze(toArray(policy.replayActions)),
  });

const STEP_REPLAY_SAFETY_MATRIX = Object.freeze({
  arxiv_import: freezePolicy({
    autoReplaySafe: false,
    idempotency: STEP_REPLAY_IDEMPOTENCY.dedupedWorkspaceWrite,
    optionalInput: ["maxResults", "selectionToken", "selectedArxivIds"],
    replayActions: ["retry_failed_step"],
    replayRequiresApproval: true,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.capabilityPolicy,
    requiredInput: ["topic"],
    retryable: true,
    stepType: "arxiv_import",
    summary:
      "Workspace-writing arXiv imports replay only from persisted sanitized topic input; importer dedupe protects repeated writes.",
  }),
  capability_call: freezePolicy({
    autoReplaySafe: false,
    idempotency: STEP_REPLAY_IDEMPOTENCY.capabilityDefined,
    optionalInput: ["approvalGateId", "capabilityVersion"],
    replayActions: ["approve", "deny", "retry_failed_step"],
    replayRequiresApproval: true,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate,
    requiredInput: ["approvedGate.capabilityId", "step.input|approvedGate.inputPreview"],
    retryable: true,
    stepType: "capability_call",
    summary:
      "Capability calls replay only after an approved gate; idempotency is delegated to the capability adapter.",
  }),
  custom_skill: freezePolicy({
    autoReplaySafe: true,
    idempotency: STEP_REPLAY_IDEMPOTENCY.readOnlyRag,
    optionalInput: ["retrievalPlan", "sessionId", "skillVersion", "userId"],
    replayActions: ["resume_from_step", "retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question", "skillId"],
    retryable: true,
    stepType: "custom_skill",
    summary:
      "Whitelisted custom skills replay through the registered custom skill runner with persisted scope and retrieval input.",
  }),
  document_rag: freezePolicy({
    autoReplaySafe: true,
    idempotency: STEP_REPLAY_IDEMPOTENCY.readOnlyRag,
    optionalInput: ["retrievalPlan", "sessionId", "userId"],
    replayActions: ["resume_from_step", "retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question"],
    retryable: true,
    stepType: "document_rag",
    summary:
      "Document RAG replay is read-only and uses persisted docIds, question, and retrieval plan when present.",
  }),
  follow_up_retrieval: freezePolicy({
    autoReplaySafe: true,
    idempotency: STEP_REPLAY_IDEMPOTENCY.readOnlyRag,
    optionalInput: ["retrievalPlan", "sessionId", "userId"],
    replayActions: ["resume_from_step", "retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question"],
    retryable: true,
    stepType: "follow_up_retrieval",
    summary:
      "Follow-up retrieval reuses the document RAG replay contract for persisted gap-filling queries.",
  }),
  research_question: freezePolicy({
    autoReplaySafe: true,
    idempotency: STEP_REPLAY_IDEMPOTENCY.readOnlyRag,
    optionalInput: ["researchQuestionId", "retrievalPlan", "sessionId", "userId"],
    replayActions: ["resume_from_step", "retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question"],
    retryable: true,
    stepType: "research_question",
    summary:
      "Research question replay is read-only and uses persisted question, document scope, and optional retrieval plan.",
  }),
  web_search: freezePolicy({
    autoReplaySafe: false,
    idempotency: STEP_REPLAY_IDEMPOTENCY.externalReadNondeterministic,
    optionalInput: ["maxResults"],
    replayActions: ["retry_failed_step"],
    replayRequiresApproval: true,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.capabilityPolicy,
    requiredInput: ["question"],
    retryable: true,
    stepType: "web_search",
    summary:
      "Web search retry is an external read through the capability adapter and is excluded from auto replay.",
  }),
});

export const getStepReplaySafetyMatrix = () => STEP_REPLAY_SAFETY_MATRIX;

export const listStepReplaySafetyPolicies = () =>
  Object.values(STEP_REPLAY_SAFETY_MATRIX);

export const getStepReplaySafetyPolicy = (stepType) =>
  STEP_REPLAY_SAFETY_MATRIX[normalizeText(stepType).toLowerCase()] ?? null;

export const getAutoReplaySafeStepTypes = () =>
  listStepReplaySafetyPolicies()
    .filter((policy) => policy.autoReplaySafe)
    .map((policy) => policy.stepType);

export const isAutoReplaySafeStepType = (stepType) =>
  Boolean(getStepReplaySafetyPolicy(stepType)?.autoReplaySafe);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const isPresent = (value) => {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "string") {
    return normalizeText(value).length > 0;
  }

  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return value !== null && value !== undefined;
};

const getPathValue = (source, path) => {
  const parts = normalizeText(path).split(".").filter(Boolean);
  let current = source;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = current[part];
  }

  return current;
};

const getStepInput = (step = {}) => {
  const detail = normalizeRecord(step.detail, {});

  return (
    normalizeRecord(step.input, null) ??
    normalizeRecord(detail.input, null) ??
    normalizeRecord(detail.capabilityInput, null) ??
    null
  );
};

const findApprovedGateForStep = ({ run = {}, step = {} } = {}) =>
  toArray(run.approvalGates).find(
    (gate) =>
      gate?.status === "approved" &&
      (!step.approvalGateId ||
        gate.id === step.approvalGateId ||
        gate.stepId === step.approvalGateId)
  ) ?? null;

const getReplaySafetyContext = ({ approvedGate, run = {}, step = {} } = {}) => ({
  approvedGate: approvedGate ?? findApprovedGateForStep({ run, step }),
  input: getStepInput(step),
  run,
  step,
});

const getInputValue = (context, requirement) => {
  const path = normalizeText(requirement);

  if (!path.includes(".")) {
    return (
      getPathValue(context.input, path) ??
      getPathValue(context.step?.input, path) ??
      getPathValue(context.step?.detail?.input, path) ??
      getPathValue(context.step?.detail?.capabilityInput, path) ??
      getPathValue(context.step?.detail, path)
    );
  }

  return getPathValue(context, path);
};

const hasRequiredInput = (context, requirement) =>
  normalizeText(requirement)
    .split("|")
    .map(normalizeText)
    .filter(Boolean)
    .some((path) => isPresent(getInputValue(context, path)));

const getMissingRequiredInput = ({ context, policy }) =>
  toArray(policy?.requiredInput).filter(
    (requirement) => !hasRequiredInput(context, requirement)
  );

const hasReplayApproval = ({ context, policy }) => {
  if (!policy?.replayRequiresApproval) {
    return true;
  }

  if (
    policy.replayApprovalPolicy ===
    STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate
  ) {
    return Boolean(context.approvedGate);
  }

  return false;
};

const getPolicyReasonCodes = ({ configuredAutoReplaySafe, context, policy }) => {
  const reasonCodes = [];
  const missingInput = getMissingRequiredInput({
    context,
    policy,
  });

  if (missingInput.length > 0) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.missingInput);
  }

  if (!hasReplayApproval({ context, policy })) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval);
  }

  if (policy.idempotency === STEP_REPLAY_IDEMPOTENCY.dedupedWorkspaceWrite) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.externalWrite);
  }

  if (
    policy.idempotency === STEP_REPLAY_IDEMPOTENCY.externalReadNondeterministic ||
    policy.idempotency === STEP_REPLAY_IDEMPOTENCY.capabilityDefined
  ) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent);
  }

  if (
    (!policy.autoReplaySafe || !configuredAutoReplaySafe) &&
    reasonCodes.length === 0
  ) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.unsafeByPolicy);
  }

  return {
    missingInput,
    reasonCodes,
  };
};

const getReasonDetails = ({ missingInput = [], reasonCodes = [] } = {}) =>
  reasonCodes.map((code) => ({
    code,
    label: STEP_REPLAY_SAFETY_REASON_DETAILS[code]?.label ?? code,
    message:
      code === STEP_REPLAY_SAFETY_REASON_CODES.missingInput &&
      missingInput.length > 0
        ? `${STEP_REPLAY_SAFETY_REASON_DETAILS[code].message} Missing: ${missingInput.join(
            ", "
          )}.`
        : STEP_REPLAY_SAFETY_REASON_DETAILS[code]?.message ?? code,
  }));

const serializePolicy = (policy) =>
  policy
    ? {
        autoReplaySafe: policy.autoReplaySafe,
        idempotency: policy.idempotency,
        optionalInput: policy.optionalInput,
        replayActions: policy.replayActions,
        replayApprovalPolicy: policy.replayApprovalPolicy,
        replayRequiresApproval: policy.replayRequiresApproval,
        requiredInput: policy.requiredInput,
        retryable: policy.retryable,
        stepType: policy.stepType,
        summary: policy.summary,
      }
    : null;

const buildStepReplaySafetyAssessment = ({
  autoReplayStepTypes = getAutoReplaySafeStepTypes(),
  approvedGate = null,
  run = {},
  step = {},
} = {}) => {
  const stepType = normalizeText(step.type).toLowerCase();
  const policy = getStepReplaySafetyPolicy(stepType);
  const configuredAutoReplaySafe = toArray(autoReplayStepTypes)
    .map((type) => normalizeText(type).toLowerCase())
    .includes(stepType);

  if (!policy) {
    const reasonCodes = [
      STEP_REPLAY_SAFETY_REASON_CODES.unsupportedStepType,
    ];

    return {
      autoReplaySafe: false,
      canAutoReplay: false,
      configuredAutoReplaySafe: false,
      idempotency: null,
      label: step.label ?? stepType ?? "Step",
      missingInput: [],
      policy: null,
      reasonCodes,
      reasons: getReasonDetails({ reasonCodes }),
      replayApprovalPolicy: null,
      replayRequiresApproval: false,
      stepId: step.id ?? "",
      stepType,
      summary: "No replay safety policy is registered for this step type.",
    };
  }

  const context = getReplaySafetyContext({
    approvedGate,
    run,
    step,
  });
  const { missingInput, reasonCodes } = getPolicyReasonCodes({
    configuredAutoReplaySafe,
    context,
    policy,
  });

  return {
    autoReplaySafe: policy.autoReplaySafe,
    canAutoReplay:
      policy.autoReplaySafe &&
      configuredAutoReplaySafe &&
      missingInput.length === 0 &&
      reasonCodes.length === 0,
    configuredAutoReplaySafe,
    idempotency: policy.idempotency,
    label: step.label ?? policy.stepType,
    missingInput,
    policy: serializePolicy(policy),
    reasonCodes,
    reasons: getReasonDetails({
      missingInput,
      reasonCodes,
    }),
    replayApprovalPolicy: policy.replayApprovalPolicy,
    replayRequiresApproval: policy.replayRequiresApproval,
    stepId: step.id ?? "",
    stepType: policy.stepType,
    summary: policy.summary,
  };
};

export { buildStepReplaySafetyAssessment };
