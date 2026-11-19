// Shared by the Capability suites that run a gated Capability past its gate.
// Not a test suite.
import { evaluateCapabilityPolicy } from "../rag/capabilities/index.js";

// Runs a Capability as its approved gate does: the approval is bound to the
// approval object hash the policy shows for this exact call, since the
// policy grants no approval without one (rag/capabilities/policy-enforcer.js).
export const executeApproved = (registry, capabilityId, payload = {}) =>
  registry.execute(capabilityId, {
    ...payload,
    approval: {
      approved: true,
      approvalObjectHash: evaluateCapabilityPolicy(
        registry.describe(capabilityId),
        payload
      ).approvalGate.approvalObjectHash,
    },
  });
