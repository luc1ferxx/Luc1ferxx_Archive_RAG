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
