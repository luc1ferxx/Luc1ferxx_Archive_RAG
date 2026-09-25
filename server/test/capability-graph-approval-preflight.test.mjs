import assert from "node:assert/strict";
import test from "node:test";

import { createTaskCreateCapability } from "../rag/capabilities/actions.js";
import { createCapabilityGraphAdapter } from "../rag/capabilities/graph-contract.js";
import {
  preflightCapabilityGraphApproval,
  verifyCapabilityGraphApproval,
} from "../rag/capabilities/graph-approval-preflight.js";
import {
  CAPABILITY_POLICY_DECISIONS,
  evaluateCapabilityPolicy,
} from "../rag/capabilities/policy-enforcer.js";
import { createCapabilityRegistry } from "../rag/capabilities/registry.js";
import { CAPABILITY_IDS } from "../rag/capabilities/shared.js";
import { createWebSearchCapability } from "../rag/capabilities/web.js";

const GRAPH_DIGEST = `sha256:${"a".repeat(64)}`;
const SCOPE = { userId: "user-1", workspaceId: "workspace-1" };

const makeFixture = ({ capabilityId = CAPABILITY_IDS.webSearch } = {}) => {
  let executions = 0;
  const registry = createCapabilityRegistry([
    createWebSearchCapability({
      webChatService: async () => {
        executions += 1;
        return { text: "Web result" };
      },
    }),
    createTaskCreateCapability({
      actionTaskService: {
        createActionTask: async () => {
          executions += 1;
          return { id: "task-1" };
        },
      },
    }),
  ]);
  const adapter = createCapabilityGraphAdapter({
    capabilityId,
    capabilityRegistry: registry,
  });

  return { adapter, executions: () => executions, registry };
};

const preflightArgs = ({ adapter, registry }, overrides = {}) => ({
  accessScope: SCOPE,
  adapter,
  authorizedAdapterIds: [adapter.id],
  capabilityRegistry: registry,
  graphDigest: GRAPH_DIGEST,
  graphRevision: 2,
  input: { question: "  Latest update?  " },
  nodeId: "web-1",
  runId: "run-1",
  ...overrides,
});

test("graph preflight binds each node and keeps the original input private without executing", () => {
  const fixture = makeFixture();
  const firstArgs = preflightArgs(fixture);
  const first = preflightCapabilityGraphApproval(firstArgs);
  const second = preflightCapabilityGraphApproval({
    ...firstArgs,
    nodeId: "web-2",
  });

  assert.equal(first.decision, CAPABILITY_POLICY_DECISIONS.needsApproval);
  assert.equal(first.approvalGate.type, "graph_capability_approval");
  assert.notEqual(first.approvalGate.id, second.approvalGate.id);
  assert.notEqual(
    first.approvalGate.approvalObjectHash,
    second.approvalGate.approvalObjectHash
  );
  assert.deepEqual(first.approvalSnapshot.executionInput.input, {
    question: "  Latest update?  ",
  });
  assert.equal(first.approvalGate.inputPreview.question, "Latest update?");
  assert.equal(Object.keys(first).includes("approvalSnapshot"), false);
  assert.equal(JSON.stringify(first).includes("  Latest update?  "), false);
  assert.equal(fixture.executions(), 0);
});

test("verification rejects V1 hashes and changed graph, input, scope, or snapshot", () => {
  const fixture = makeFixture();
  const args = preflightArgs(fixture);
  const pending = preflightCapabilityGraphApproval(args);
  const approval = {
    action: "approve",
    approvalObjectHash: pending.approvalGate.approvalObjectHash,
    gateId: pending.approvalGate.id,
  };
  const verifyArgs = {
    ...args,
    approval,
    approvalGate: pending.approvalGate,
    approvalSnapshot: pending.approvalSnapshot,
  };
  const rawCapability = fixture.registry.get(CAPABILITY_IDS.webSearch);
  const v1Policy = evaluateCapabilityPolicy(rawCapability, {
    accessScope: SCOPE,
    input: args.input,
  });

  assert.equal(v1Policy.decision, CAPABILITY_POLICY_DECISIONS.needsApproval);
  assert.notEqual(
    v1Policy.approvalGate.approvalObjectHash,
    pending.approvalGate.approvalObjectHash
  );
  assert.deepEqual(verifyCapabilityGraphApproval(verifyArgs), {
    capabilityApproval: {
      approved: true,
      approvalObjectHash: v1Policy.approvalGate.approvalObjectHash,
      gateId: v1Policy.approvalGate.id,
      source: "agent_run_action",
    },
    input: args.input,
  });

  const changed = [
    { approval: { ...approval, approvalObjectHash: v1Policy.approvalGate.approvalObjectHash } },
    { approval: { approved: true } },
    { approval: { ...approval, approved: true, denied: true } },
    { runId: "run-2" },
    { nodeId: "web-2" },
    { graphDigest: `sha256:${"b".repeat(64)}` },
    { graphRevision: 3 },
    { input: { question: "Different question" } },
    { accessScope: { userId: "user-2", workspaceId: "workspace-1" } },
    {
      approvalSnapshot: {
        ...pending.approvalSnapshot,
        executionInput: {
          ...pending.approvalSnapshot.executionInput,
          input: { question: "Different question" },
        },
      },
    },
    {
      approvalSnapshot: {
        ...pending.approvalSnapshot,
        executionInput: {
          ...pending.approvalSnapshot.executionInput,
          capabilityApproval: {
            ...pending.approvalSnapshot.executionInput.capabilityApproval,
            gateId: "approval:forged",
          },
        },
      },
    },
  ];

  for (const override of changed) {
    assert.throws(
      () => verifyCapabilityGraphApproval({ ...verifyArgs, ...override }),
      { name: "CapabilityGraphApprovalError", code: "graph_approval_binding_mismatch" }
    );
  }
  assert.equal(fixture.executions(), 0);
});

test("graph approval cannot grant V1 policy; verified private binding can", () => {
  const fixture = makeFixture();
  const args = preflightArgs(fixture);
  const pending = preflightCapabilityGraphApproval(args);
  const rawCapability = fixture.registry.get(CAPABILITY_IDS.webSearch);
  const graphApproval = {
    approved: true,
    approvalObjectHash: pending.approvalGate.approvalObjectHash,
    gateId: pending.approvalGate.id,
    source: "agent_run_action",
  };

  assert.equal(
    evaluateCapabilityPolicy(rawCapability, {
      accessScope: SCOPE,
      approval: graphApproval,
      input: args.input,
    }).decision,
    CAPABILITY_POLICY_DECISIONS.needsApproval
  );

  const verified = verifyCapabilityGraphApproval({
    ...args,
    approval: graphApproval,
    approvalGate: pending.approvalGate,
    approvalSnapshot: pending.approvalSnapshot,
  });

  assert.equal(
    evaluateCapabilityPolicy(rawCapability, {
      accessScope: SCOPE,
      approval: verified.capabilityApproval,
      input: verified.input,
    }).decision,
    CAPABILITY_POLICY_DECISIONS.allowed
  );
  assert.equal(fixture.executions(), 0);
});

test("preflight fails closed for missing authorization, scope, and invalid resolved input", () => {
  const fixture = makeFixture({ capabilityId: CAPABILITY_IDS.taskCreate });
  const args = preflightArgs(fixture, {
    input: { title: "Review contract" },
    nodeId: "task-1",
  });

  assert.throws(
    () => preflightCapabilityGraphApproval({ ...args, authorizedAdapterIds: [] }),
    { code: "graph_approval_unauthorized_capability" }
  );
  assert.throws(
    () => preflightCapabilityGraphApproval({ ...args, accessScope: {} }),
    { code: "graph_approval_missing_scope" }
  );
  assert.throws(
    () => preflightCapabilityGraphApproval({ ...args, input: { title: "Review", approval: {} } }),
    { name: "SkillInputContractError" }
  );
  assert.throws(
    () => preflightCapabilityGraphApproval({ ...args, graphDigest: "unbound" }),
    { code: "graph_approval_invalid_binding" }
  );
  assert.equal(fixture.executions(), 0);
});
