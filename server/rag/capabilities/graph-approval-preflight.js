import { isDeepStrictEqual } from "node:util";

import { normalizeText } from "../../lib/normalize-text.js";
import { normalizeTaskAccessScope } from "../tasks.js";
import {
  createSkillInputContractError,
  validateSkillValues,
} from "../skills/skill-contract.js";
import {
  createApprovalExecutionSnapshot,
  verifyApprovalExecutionSnapshot,
} from "./approval-execution-snapshot.js";
import { createCapabilityGraphAdapter } from "./graph-contract.js";
import {
  CAPABILITY_POLICY_DECISIONS,
  evaluateCapabilityPolicy,
} from "./policy-enforcer.js";

export const GRAPH_CAPABILITY_APPROVAL_TYPE = "graph_capability_approval";
const GRAPH_VERSION = "v3";
const GRAPH_BINDING_VERSION = 1;
const GRAPH_DIGEST_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const APPROVED_DECISIONS = new Set([
  "approve",
  "approved",
  "confirm",
  "confirmed",
]);

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const reject = (code, message) => {
  const error = new Error(message);
  error.name = "CapabilityGraphApprovalError";
  error.code = code;
  error.status = 409;
  throw error;
};

const resolveBinding = ({ graphDigest, graphRevision, nodeId, runId }) => {
  const binding = {
    graphBindingVersion: GRAPH_BINDING_VERSION,
    graphDigest: normalizeText(graphDigest),
    graphRevision,
    graphVersion: GRAPH_VERSION,
    nodeId: normalizeText(nodeId),
    runId: normalizeText(runId),
  };

  if (
    !binding.runId ||
    !binding.nodeId ||
    !GRAPH_DIGEST_PATTERN.test(binding.graphDigest) ||
    !Number.isSafeInteger(graphRevision) ||
    graphRevision < 0
  ) {
    reject(
      "graph_approval_invalid_binding",
      "Graph approval requires a run, graph digest/revision, and node identity."
    );
  }

  return binding;
};

const resolveCapability = ({ adapter, authorizedAdapterIds, capabilityRegistry }) => {
  const adapterId = normalizeText(adapter?.id);
  const capabilityId = adapterId.startsWith("capability:")
    ? adapterId.slice("capability:".length)
    : "";
  const authorized = Array.isArray(authorizedAdapterIds) &&
    authorizedAdapterIds.includes(adapterId);
  const registeredAdapter = capabilityId
    ? createCapabilityGraphAdapter({ capabilityId, capabilityRegistry })
    : null;
  const capability = capabilityRegistry?.get?.(capabilityId) ?? null;

  if (
    !authorized ||
    !registeredAdapter ||
    !capability ||
    adapter?.kind !== "capability" ||
    adapter?.version !== registeredAdapter.version ||
    adapter?.id !== registeredAdapter.id
  ) {
    reject(
      "graph_approval_unauthorized_capability",
      "Graph capability is not in the runtime-authorized catalog."
    );
  }

  return { adapter: registeredAdapter, capability };
};

const validateResolvedInput = ({ adapter, authorizedDocIds, input }) => {
  if (!isRecord(input)) {
    throw createSkillInputContractError(["capability input must be an object"]);
  }

  const fields = Object.keys(adapter.inputSchema);

  if (Object.keys(input).some((field) => !fields.includes(field))) {
    throw createSkillInputContractError([
      "capability input contains an undeclared field",
    ]);
  }

  const checked = validateSkillValues({
    allowNestedValue: false,
    output: input,
    schema: adapter.inputSchema,
  });

  if (!checked.ok) {
    throw createSkillInputContractError(checked.errors);
  }

  for (const [field, spec] of Object.entries(adapter.inputSchema)) {
    if (!spec.scoped || !Object.hasOwn(checked.output, field)) {
      continue;
    }

    const values = checked.output[field];
    const authorized = Array.isArray(authorizedDocIds) &&
      Array.isArray(values) &&
      values.every((value) => authorizedDocIds.includes(value));

    if (!authorized) {
      reject(
        "graph_approval_out_of_scope_input",
        `Graph capability input ${field} is outside the authorized document set.`
      );
    }
  }

  return checked.output;
};

const attachPrivateSnapshot = (result, approvalSnapshot) => {
  Object.defineProperty(result, "approvalSnapshot", {
    configurable: false,
    enumerable: false,
    value: approvalSnapshot,
    writable: false,
  });

  return result;
};

/**
 * Read-only execution preflight for one resolved v3 Capability node. The caller
 * supplies the validated graph's runtime-authorized adapter IDs and digest.
 * This function never calls a Capability, reserves budget, or updates a run.
 */
export const preflightCapabilityGraphApproval = ({
  accessScope = {},
  adapter,
  authorizedAdapterIds,
  authorizedDocIds,
  capabilityRegistry,
  graphDigest,
  graphRevision,
  input,
  nodeId,
  runId,
} = {}) => {
  const binding = resolveBinding({ graphDigest, graphRevision, nodeId, runId });
  const { adapter: registeredAdapter, capability } = resolveCapability({
    adapter,
    authorizedAdapterIds,
    capabilityRegistry,
  });
  const scope = normalizeTaskAccessScope(accessScope);

  if (
    capability.accessScope?.required === true &&
    (!scope.userId || !scope.workspaceId)
  ) {
    reject(
      "graph_approval_missing_scope",
      "Graph capability requires a user and workspace access scope."
    );
  }

  const resolvedInput = validateResolvedInput({
    adapter: registeredAdapter,
    authorizedDocIds,
    input,
  });
  const policyResult = evaluateCapabilityPolicy(capability, {
    accessScope,
    approval: {},
    input: resolvedInput,
  });

  if (policyResult.decision === CAPABILITY_POLICY_DECISIONS.blocked) {
    reject(
      "graph_approval_policy_blocked",
      `Graph capability policy blocked execution: ${policyResult.reasons.join(", ")}.`
    );
  }

  if (policyResult.decision === CAPABILITY_POLICY_DECISIONS.allowed) {
    return { decision: CAPABILITY_POLICY_DECISIONS.allowed };
  }

  if (
    policyResult.decision !== CAPABILITY_POLICY_DECISIONS.needsApproval ||
    !policyResult.approvalGate
  ) {
    reject("graph_approval_policy_invalid", "Graph capability approval policy is invalid.");
  }

  const baseGate = policyResult.approvalGate;
  const capabilityApproval = {
    approvalObjectHash: baseGate.approvalObjectHash,
    gateId: baseGate.id,
  };
  const executionSnapshot = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    executionInput: { binding, capabilityApproval, input: resolvedInput },
    inputPreview: baseGate.inputPreview,
  });
  const gate = {
    ...baseGate,
    ...binding,
    approvalObjectHash: executionSnapshot.approvalObjectHash,
    id: `graph-approval:${executionSnapshot.approvalObjectHash.slice("sha256:".length)}`,
    snapshotVersion: executionSnapshot.snapshotVersion,
    type: GRAPH_CAPABILITY_APPROVAL_TYPE,
  };
  const privateSnapshot = {
    approvalObjectHash: gate.approvalObjectHash,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    executionInput: executionSnapshot.privateSnapshot.executionInput,
    gateId: gate.id,
    snapshotVersion: executionSnapshot.snapshotVersion,
  };

  return attachPrivateSnapshot(
    {
      approvalGate: gate,
      decision: CAPABILITY_POLICY_DECISIONS.needsApproval,
      reasons: policyResult.reasons,
      riskFlags: policyResult.riskFlags,
    },
    privateSnapshot
  );
};

/** Verify a graph-only approval against its private snapshot and current node. */
export const verifyCapabilityGraphApproval = ({
  approval,
  approvalGate,
  approvalSnapshot,
  ...preflightArgs
} = {}) => {
  const expected = preflightCapabilityGraphApproval(preflightArgs);

  if (expected.decision !== CAPABILITY_POLICY_DECISIONS.needsApproval) {
    reject("graph_approval_not_required", "Graph node has no pending approval gate.");
  }

  const decision = normalizeText(approval?.decision ?? approval?.action).toLowerCase();
  const approved =
    approval?.denied !== true &&
    (!decision || APPROVED_DECISIONS.has(decision)) &&
    (approval?.approved === true || APPROVED_DECISIONS.has(decision));

  if (
    !approved ||
    !isRecord(approvalGate) ||
    !isRecord(approvalSnapshot) ||
    normalizeText(approval?.gateId) !== expected.approvalGate.id ||
    normalizeText(approval?.approvalObjectHash) !==
      expected.approvalGate.approvalObjectHash ||
    !isDeepStrictEqual(approvalGate, expected.approvalGate) ||
    !isDeepStrictEqual(approvalSnapshot, expected.approvalSnapshot)
  ) {
    reject(
      "graph_approval_binding_mismatch",
      "Graph approval does not match the pending node and private snapshot."
    );
  }

  const executionInput = verifyApprovalExecutionSnapshot({
    accessScope: preflightArgs.accessScope,
    approvalObjectHash: approvalGate.approvalObjectHash,
    capabilityId: approvalGate.capabilityId,
    capabilityVersion: approvalGate.capabilityVersion,
    inputPreview: approvalGate.inputPreview,
    privateSnapshot: approvalSnapshot,
  });

  if (
    !isRecord(executionInput) ||
    !isDeepStrictEqual(executionInput.binding, {
      graphBindingVersion: GRAPH_BINDING_VERSION,
      graphDigest: normalizeText(preflightArgs.graphDigest),
      graphRevision: preflightArgs.graphRevision,
      graphVersion: GRAPH_VERSION,
      nodeId: normalizeText(preflightArgs.nodeId),
      runId: normalizeText(preflightArgs.runId),
    })
  ) {
    reject("graph_approval_binding_mismatch", "Graph approval node identity changed.");
  }

  // The graph approval hash is never passed to the V1 Capability policy. A
  // future continuation can use this proof only after graph verification.
  return {
    capabilityApproval: {
      approved: true,
      approvalObjectHash: executionInput.capabilityApproval.approvalObjectHash,
      gateId: executionInput.capabilityApproval.gateId,
      source: "agent_run_action",
    },
    input: executionInput.input,
  };
};
