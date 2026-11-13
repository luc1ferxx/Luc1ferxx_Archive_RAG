import { normalizeText } from "../lib/normalize-text.js";
import { SKILL_EFFECTS } from "./skills/skill-contract.js";

// What may happen to one persisted step after it was interrupted or failed.
//
// Nothing replays a step on its own automatically. Startup recovery continues
// an interrupted execution graph as a whole (agent-run-recovery.js) and hands
// every other interrupted run to an operator. What is left for a single step
// is one operator action, `retry_failed_step`, and this matrix says which step
// types have it and what a retry may repeat. Until ADR 0001 phase 9 the matrix
// also carried an "auto replay safe" column; its only entry was the
// `custom_skill` step of the deleted V1 sequential chain.
//
// `replayActions` has to agree with the step handlers
// (agent-run-step-handlers/): a type listed with `retry_failed_step` must have
// a handler that can retry it. The recovery panel offers the action from this
// matrix alone, so a type whose handler always refuses must not list it.

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
  // Decided by the execution graph that ran the node, never by the step.
  graphOwned: "graph_owned",
  memoryWritingRag: "memory_writing_rag",
});

export const STEP_REPLAY_SAFETY_REASON_CODES = Object.freeze({
  externalWrite: "external_write",
  graphNodeStep: "graph_node_step",
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
  [STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep]: Object.freeze({
    label: "Graph node",
    message:
      "The step is a node of an execution graph and is never replayed on its own.",
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
    message: "The Skill that ran the step declares that it must not be replayed.",
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
  // An approval-capable primary step. Its handler refuses a direct retry (the
  // step holds no hash-bound approval); what can be retried is the
  // `capability_call` step an approval queues.
  arxiv_import: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.dedupedWorkspaceWrite,
    optionalInput: ["maxResults", "selectionToken", "selectedArxivIds"],
    replayActions: [],
    replayRequiresApproval: true,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.capabilityPolicy,
    requiredInput: ["topic"],
    retryable: false,
    stepType: "arxiv_import",
    summary:
      "A workspace-writing arXiv import needs approval, so its primary step is not retried on its own. The retry goes through the hash-bound capability_call step an approval queues; importer dedupe protects repeated writes.",
  }),
  capability_call: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.capabilityDefined,
    optionalInput: ["capabilityVersion"],
    replayActions: ["approve", "deny", "retry_failed_step"],
    replayRequiresApproval: true,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate,
    requiredInput: [
      "approvedGate.capabilityId",
      "approvedGate.approvalObjectHash",
      "step.approvalGateId",
      "step.detail.approvalObjectHash",
    ],
    retryable: true,
    stepType: "capability_call",
    summary:
      "Capability calls replay only from a hash-bound approved gate and private execution snapshot; idempotency is delegated to the capability adapter.",
  }),
  // A custom Skill runs only as a node of its execution graph, so its step
  // has no action of its own: an interrupted graph is continued as a whole,
  // and a failed node is not retried. The replay guard refuses the step
  // whatever asks (agent-run-graph-replay-guard.js).
  custom_skill: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.graphOwned,
    optionalInput: [],
    replayActions: [],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: [],
    retryable: false,
    stepType: "custom_skill",
    summary:
      "A custom Skill runs only as a node of its execution graph. Its step is never replayed on its own: an interrupted graph is continued by whole-graph recovery, and a failed node is not retried.",
  }),
  document_rag: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.memoryWritingRag,
    optionalInput: ["retrievalPlan", "sessionId", "userId"],
    replayActions: ["retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question"],
    retryable: true,
    stepType: "document_rag",
    summary:
      "Document RAG can write session and long-term memory. Interrupted work goes to an operator; an explicit failed-step retry may repeat those writes.",
  }),
  follow_up_retrieval: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.memoryWritingRag,
    optionalInput: ["retrievalPlan", "sessionId", "userId"],
    replayActions: ["retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question"],
    retryable: true,
    stepType: "follow_up_retrieval",
    summary:
      "Follow-up document retrieval shares Document RAG's memory-writing boundary and requires an explicit failed-step retry.",
  }),
  research_question: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.memoryWritingRag,
    optionalInput: ["researchQuestionId", "retrievalPlan", "sessionId", "userId"],
    replayActions: ["retry_failed_step"],
    replayRequiresApproval: false,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.none,
    requiredInput: ["docIds", "question"],
    retryable: true,
    stepType: "research_question",
    summary:
      "Research questions use the memory-writing RAG chat path. Interrupted work goes to an operator; an explicit failed-step retry may repeat those writes.",
  }),
  // An approval-capable primary step, like arxiv_import above.
  web_search: freezePolicy({
    idempotency: STEP_REPLAY_IDEMPOTENCY.externalReadNondeterministic,
    optionalInput: ["maxResults"],
    replayActions: [],
    replayRequiresApproval: true,
    replayApprovalPolicy: STEP_REPLAY_APPROVAL_POLICIES.capabilityPolicy,
    requiredInput: ["question"],
    retryable: false,
    stepType: "web_search",
    summary:
      "A web search is an external read that needs approval, so its primary step is not retried on its own. The retry goes through the hash-bound capability_call step an approval queues; interrupted work goes to an operator.",
  }),
});

export const getStepReplaySafetyMatrix = () => STEP_REPLAY_SAFETY_MATRIX;

export const listStepReplaySafetyPolicies = () =>
  Object.values(STEP_REPLAY_SAFETY_MATRIX);

// Own keys only: a step type such as "constructor" must not resolve to
// something inherited from Object.prototype.
export const getStepReplaySafetyPolicy = (stepType) => {
  const key = normalizeText(stepType).toLowerCase();

  return Object.hasOwn(STEP_REPLAY_SAFETY_MATRIX, key)
    ? STEP_REPLAY_SAFETY_MATRIX[key]
    : null;
};

// The one action left for a single step: may an operator retry a failed step
// of this type on its own. A type without a policy has no handler either, so
// it is not retryable.
export const isStepRetryAllowed = (stepType) =>
  Boolean(
    getStepReplaySafetyPolicy(stepType)?.replayActions.includes("retry_failed_step")
  );

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
    return Boolean(
      context.approvedGate &&
        normalizeText(context.step?.approvalGateId) ===
          normalizeText(context.approvedGate.id) &&
        normalizeText(context.step?.detail?.approvalObjectHash) ===
          normalizeText(context.approvedGate.approvalObjectHash)
    );
  }

  return false;
};

/**
 * A step type is a coarse category: the same type can cover a RAG read and a
 * step that writes. Where the Skill that ran the step persisted its own
 * contract with it (describeSkillReplayContract), that declaration adds to
 * what the step type says a replay would risk.
 *
 * It only ever adds a reason. A step recorded before the contract existed
 * declares nothing and keeps the codes of its type. Unrecognised effects are
 * treated as writing, because a value we cannot read is not evidence that the
 * Skill is safe.
 */
const getDeclaredContractReasonCodes = (context) => {
  const declared = context?.input ?? {};
  const effects = normalizeText(declared.effects);
  const refusesReplay = declared.replaySafe === false;

  if (!effects && !refusesReplay) {
    return [];
  }

  const reasonCodes = [];

  if (effects === SKILL_EFFECTS.externalRead) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent);
  } else if (effects && effects !== SKILL_EFFECTS.readOnly) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.externalWrite);
  }

  if (refusesReplay && reasonCodes.length === 0) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.unsafeByPolicy);
  }

  return reasonCodes;
};

const getPolicyReasonCodes = ({ context, policy }) => {
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
    policy.idempotency === STEP_REPLAY_IDEMPOTENCY.capabilityDefined ||
    policy.idempotency === STEP_REPLAY_IDEMPOTENCY.memoryWritingRag
  ) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent);
  }

  if (policy.idempotency === STEP_REPLAY_IDEMPOTENCY.graphOwned) {
    reasonCodes.push(STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep);
  }

  reasonCodes.push(...getDeclaredContractReasonCodes(context));

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

// The reason codes say what a replay of the step would risk or lack. Every
// registered step type has at least one, which is why none is replayed without
// an operator.
const buildStepReplaySafetyAssessment = ({
  approvedGate = null,
  run = {},
  step = {},
} = {}) => {
  const stepType = normalizeText(step.type).toLowerCase();
  const policy = getStepReplaySafetyPolicy(stepType);

  if (!policy) {
    const reasonCodes = [
      STEP_REPLAY_SAFETY_REASON_CODES.unsupportedStepType,
    ];

    return {
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
    context,
    policy,
  });

  return {
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
