import {
  AGENT_INTERRUPT_TYPES,
  AgentRunInterruptError,
  setAgentRunInterruptPrivateDetail,
} from "../agent-interrupts.js";
import { createApprovalExecutionSnapshot } from "./approval-execution-snapshot.js";
import { normalizeText } from "../../lib/normalize-text.js";

export const CAPABILITY_POLICY_DECISIONS = Object.freeze({
  allowed: "allowed",
  blocked: "blocked",
  needsApproval: "needs_approval",
});

const APPROVAL_MODES = new Set([
  "approval_required",
  "manual",
  "user_confirmation",
]);

const APPROVED_DECISIONS = new Set([
  "approve",
  "approved",
  "confirm",
  "confirmed",
]);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const getPolicyMode = (approvalPolicy = {}) =>
  normalizeText(approvalPolicy.mode).toLowerCase();

const hasAccessScope = (accessScope = {}) =>
  Boolean(accessScope && typeof accessScope === "object" && !Array.isArray(accessScope));

const BOUND_APPROVAL_SOURCES = new Set([
  "agent_run_action",
  "agent_run_step_retry",
  "task_action",
]);

const isApprovalIntentGranted = (approval = {}) =>
  approval.approved === true ||
  APPROVED_DECISIONS.has(
    normalizeText(approval.decision ?? approval.action).toLowerCase()
  );

const isApprovalGranted = ({ approval = {}, approvalGate = null } = {}) => {
  if (!isApprovalIntentGranted(approval)) {
    return false;
  }

  const approvalSource = normalizeText(approval.source).toLowerCase();
  const suppliedHash = normalizeText(approval.approvalObjectHash);
  const suppliedGateId = normalizeText(approval.gateId);
  const requiresBinding =
    BOUND_APPROVAL_SOURCES.has(approvalSource) || Boolean(suppliedHash);

  if (!requiresBinding) {
    return true;
  }

  return (
    Boolean(approvalGate) &&
    suppliedHash === approvalGate.approvalObjectHash &&
    (!suppliedGateId || suppliedGateId === approvalGate.id)
  );
};

const getPrimitivePreviewValue = (value) => {
  if (typeof value === "string") {
    return normalizeText(value).slice(0, 240);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .filter((item) => ["string", "number", "boolean"].includes(typeof item))
      .map(getPrimitivePreviewValue)
      .slice(0, 10);
  }

  return null;
};

const normalizeJsonType = (type) => normalizeText(type).toLowerCase();

const getTypeError = ({ field, type, value }) => {
  const normalizedType = normalizeJsonType(type);

  if (!normalizedType || value === undefined || value === null) {
    return null;
  }

  if (normalizedType === "array") {
    return Array.isArray(value) ? null : `${field} must be an array`;
  }

  if (normalizedType === "integer") {
    return Number.isInteger(value) ? null : `${field} must be an integer`;
  }

  if (normalizedType === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : `${field} must be a number`;
  }

  if (normalizedType === "object") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? null
      : `${field} must be an object`;
  }

  if (normalizedType === "string") {
    return typeof value === "string" && normalizeText(value)
      ? null
      : `${field} must be a non-empty string`;
  }

  if (normalizedType === "boolean") {
    return typeof value === "boolean" ? null : `${field} must be a boolean`;
  }

  return null;
};

const validateInputSchema = ({ input = {}, schema = {} } = {}) => {
  const errors = [];
  const inputRecord = normalizeRecord(input, null);

  if (!inputRecord) {
    return ["input must be an object"];
  }

  const rootTypeError = getTypeError({
    field: "input",
    type: schema.type,
    value: inputRecord,
  });

  if (rootTypeError) {
    errors.push(rootTypeError);
  }

  for (const field of toArray(schema.required)) {
    if (!(field in inputRecord)) {
      errors.push(`${field} is required`);
    }
  }

  const properties = normalizeRecord(schema.properties);

  for (const [field, fieldSchema] of Object.entries(properties)) {
    const fieldTypeError = getTypeError({
      field,
      type: fieldSchema?.type,
      value: inputRecord[field],
    });

    if (fieldTypeError) {
      errors.push(fieldTypeError);
    }
  }

  return errors;
};

const buildSanitizedInput = ({ input = {}, privacyPolicy = {} } = {}) => {
  const sanitizedFields = new Set(toArray(privacyPolicy.sanitizedInputFields));

  return Object.fromEntries(
    Object.entries(input).map(([field, value]) => [
      field,
      sanitizedFields.has(field) && typeof value === "string"
        ? normalizeText(value)
        : value,
    ])
  );
};

const buildInputPreview = ({ input = {}, privacyPolicy = {} } = {}) => {
  const sanitizedFields = toArray(privacyPolicy.sanitizedInputFields);

  return Object.fromEntries(
    sanitizedFields
      .map((field) => [field, getPrimitivePreviewValue(input[field])])
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
};

const collectRiskFlags = ({ capability = {}, input = {} } = {}) => {
  const approvalPolicy = normalizeRecord(capability.approvalPolicy);
  const privacyPolicy = normalizeRecord(capability.privacyPolicy);
  const flags = [];

  if (privacyPolicy.externalCall) {
    flags.push("external_call");
  }

  if (approvalPolicy.writesWorkspace) {
    flags.push("writes_workspace");
  }

  if (privacyPolicy.storesResult) {
    flags.push("stores_result");
  }

  if (
    privacyPolicy.externalCall &&
    Object.keys(input).length > 0 &&
    toArray(privacyPolicy.sanitizedInputFields).length === 0
  ) {
    flags.push("no_sanitized_input_preview");
  }

  return flags;
};

const requiresApproval = (approvalPolicy = {}) =>
  Boolean(approvalPolicy.userConfirmationRequired) ||
  Boolean(approvalPolicy.requiresApproval) ||
  APPROVAL_MODES.has(getPolicyMode(approvalPolicy));

const attachPrivateSanitizedInput = (policyResult, sanitizedInput) => {
  Object.defineProperty(policyResult, "sanitizedInput", {
    configurable: false,
    enumerable: false,
    value: sanitizedInput,
    writable: false,
  });

  return policyResult;
};

const buildApprovalGate = ({
  accessScope = {},
  capability = {},
  input = {},
  policyResult = {},
} = {}) => {
  const capabilityId = normalizeText(capability.id);
  const capabilityVersion = normalizeText(capability.version);
  const inputPreview = buildInputPreview({
    input,
    privacyPolicy: capability.privacyPolicy,
  });
  const executionSnapshot = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId,
    capabilityVersion,
    executionInput: input,
    inputPreview,
  });
  const gate = {
    id: `approval:${capabilityId}:${capabilityVersion}:${executionSnapshot.approvalObjectHash.slice(
      "sha256:".length
    )}`,
    type: "capability_approval",
    status: "pending",
    approvalObjectHash: executionSnapshot.approvalObjectHash,
    snapshotVersion: executionSnapshot.snapshotVersion,
    capabilityId,
    capabilityVersion,
    capabilityLabel: normalizeText(capability.label),
    inputPreview,
    policy: {
      mode: getPolicyMode(capability.approvalPolicy) || "direct",
      externalCall: Boolean(capability.privacyPolicy?.externalCall),
      storesResult: Boolean(capability.privacyPolicy?.storesResult),
      writesWorkspace: Boolean(capability.approvalPolicy?.writesWorkspace),
    },
    reason:
      normalizeText(capability.approvalPolicy?.reason) ||
      "User confirmation is required before this capability can execute.",
    riskFlags: policyResult.riskFlags ?? [],
  };

  return {
    approvalGate: gate,
    approvalSnapshot: {
      gateId: gate.id,
      capabilityId,
      capabilityVersion,
      approvalObjectHash: executionSnapshot.approvalObjectHash,
      snapshotVersion: executionSnapshot.snapshotVersion,
      executionInput: executionSnapshot.privateSnapshot.executionInput,
    },
  };
};

export class CapabilityPolicyError extends Error {
  constructor({ message, policyResult } = {}) {
    super(normalizeText(message) || "Capability policy blocked execution.");
    this.name = "CapabilityPolicyError";
    this.policyResult = normalizeRecord(policyResult);
  }
}

export const evaluateCapabilityPolicy = (
  capability,
  { accessScope = {}, approval = {}, input = {} } = {}
) => {
  const sanitizedInput = buildSanitizedInput({
    input: normalizeRecord(input),
    privacyPolicy: capability.privacyPolicy,
  });
  const validationErrors = validateInputSchema({
    input: sanitizedInput,
    schema: capability.inputSchema,
  });
  const riskFlags = collectRiskFlags({
    capability,
    input: sanitizedInput,
  });
  const approvalRequired = requiresApproval(capability.approvalPolicy);
  const missingAccessScope =
    Boolean(capability.accessScope?.required) && !hasAccessScope(accessScope);

  if (validationErrors.length > 0 || missingAccessScope) {
    const reasons = [
      ...validationErrors,
      missingAccessScope ? "accessScope is required" : null,
    ].filter(Boolean);

    return attachPrivateSanitizedInput(
      {
        decision: CAPABILITY_POLICY_DECISIONS.blocked,
        reasons,
        riskFlags,
      },
      sanitizedInput
    );
  }

  const approvalBinding = approvalRequired
    ? buildApprovalGate({
        accessScope,
        capability,
        input: sanitizedInput,
        policyResult: {
          riskFlags,
        },
      })
    : null;

  if (
    approvalRequired &&
    !isApprovalGranted({
      approval,
      approvalGate: approvalBinding?.approvalGate,
    })
  ) {
    const policyResult = attachPrivateSanitizedInput(
      {
        decision: CAPABILITY_POLICY_DECISIONS.needsApproval,
        reasons: ["user_confirmation_required"],
        riskFlags,
      },
      sanitizedInput
    );

    const approvalResult = {
      ...policyResult,
      approvalGate: approvalBinding.approvalGate,
    };

    Object.defineProperty(approvalResult, "approvalSnapshot", {
      configurable: false,
      enumerable: false,
      value: approvalBinding.approvalSnapshot,
      writable: false,
    });

    return approvalResult;
  }

  return attachPrivateSanitizedInput(
    {
      decision: CAPABILITY_POLICY_DECISIONS.allowed,
      reasons: [],
      riskFlags,
    },
    sanitizedInput
  );
};

export const enforceCapabilityPolicy = (
  capability,
  { accessScope = {}, approval = {}, input = {} } = {}
) => {
  const policyResult = evaluateCapabilityPolicy(capability, {
    accessScope,
    approval,
    input,
  });

  if (policyResult.decision === CAPABILITY_POLICY_DECISIONS.blocked) {
    throw new CapabilityPolicyError({
      message: `Capability ${capability.id} blocked: ${policyResult.reasons.join(
        ", "
      )}.`,
      policyResult,
    });
  }

  if (policyResult.decision === CAPABILITY_POLICY_DECISIONS.needsApproval) {
    const approvalGate = policyResult.approvalGate;

    throw setAgentRunInterruptPrivateDetail(
      new AgentRunInterruptError({
        type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
        message: `Capability ${capability.id} requires user approval.`,
        publicMessage: `${approvalGate.capabilityLabel} requires approval before execution.`,
        detail: {
          approvalGate,
          capabilityId: approvalGate.capabilityId,
          policyResult: {
            decision: policyResult.decision,
            reasons: policyResult.reasons,
            riskFlags: policyResult.riskFlags,
          },
        },
      }),
      {
        approvalSnapshot: policyResult.approvalSnapshot,
      }
    );
  }

  return policyResult;
};

export const buildCapabilityApprovalClarification = (error) => {
  const approvalGate = error?.detail?.approvalGate;
  const capabilityLabel =
    approvalGate?.capabilityLabel ?? approvalGate?.capabilityId ?? "Capability";

  return {
    reason: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
    summary: `${capabilityLabel} requires approval before execution.`,
    question: `Approve ${capabilityLabel}?`,
    traceType: "capability_approval_gate",
    traceLabel: "Capability Approval",
    detail: {
      approvalGate,
      approvalGates: approvalGate ? [approvalGate] : [],
      policyResult: error?.detail?.policyResult ?? null,
    },
  };
};
