import assert from "node:assert/strict";
import test from "node:test";

import { isAgentRunInterrupt } from "../rag/agent-interrupts.js";
import { createCapabilityRegistry } from "../rag/capabilities/index.js";
import {
  CONNECTOR_REPLAY_STEP_TYPE,
  TEST_CONNECTOR_CAPABILITY_ID,
  TEST_CONNECTOR_ID,
  createConnectorRegistry,
  createDefaultConnectorRegistry,
  createTestConnectorSpec,
  validateAgentConnectorSpec,
} from "../rag/connectors/index.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

test("connector spec validates controlled capability contracts", () => {
  const validation = validateAgentConnectorSpec(createTestConnectorSpec());

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.spec.id, TEST_CONNECTOR_ID);
  assert.equal(validation.spec.type, "agent_connector");
  assert.deepEqual(
    validation.spec.capabilities.map((capability) => capability.id),
    [TEST_CONNECTOR_CAPABILITY_ID]
  );
  assert.equal(
    validation.spec.capabilities[0].replaySafety.stepType,
    CONNECTOR_REPLAY_STEP_TYPE
  );
  assert.equal(validation.spec.capabilities[0].replaySafety.autoReplaySafe, false);
  assert.equal(
    validation.spec.capabilities[0].replaySafety.replayRequiresApproval,
    true
  );
  assert.equal(
    validation.spec.capabilities[0].sandboxPolicy.profile,
    "connector_external_read"
  );
  assert.equal(validation.spec.capabilities[0].sandboxPolicy.allowNetwork, true);
  assert.deepEqual(validation.spec.capabilities[0].secretPolicy.requiredSecretRefs, [
    "TEST_CONNECTOR_API_TOKEN",
  ]);
  assert.equal(validation.spec.capabilities[0].secretPolicy.exposure, "refs_only");
  assert.doesNotThrow(() => JSON.stringify(validation.spec));
});

test("connector validation rejects approval, replay, sandbox, and secret bypasses", () => {
  const unsafeConnector = createTestConnectorSpec();

  unsafeConnector.capabilities[0].approvalPolicy = {
    mode: "direct",
  };
  unsafeConnector.capabilities[0].privacyPolicy = {
    externalCall: true,
    storesResult: false,
  };
  unsafeConnector.capabilities[0].replaySafety = {
    autoReplaySafe: true,
    replayRequiresApproval: false,
    stepType: "mcp_tool",
  };
  unsafeConnector.capabilities[0].sandboxPolicy = {
    allowNetwork: false,
  };
  unsafeConnector.capabilities[0].secretPolicy = {
    exposure: "values",
    requiredSecretRefs: ["sk-secret-value"],
  };

  const validation = validateAgentConnectorSpec(unsafeConnector);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /must require user approval/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /sanitizedInputFields/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /must replay through capability_call/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /must not be marked auto replay safe/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /sandboxPolicy\.profile/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /allowNetwork/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /secret exposure must be refs_only/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /uppercase secret name/.test(error)),
    validation.errors.join("\n")
  );
});

test("connector registry maps connector capabilities through capability approval gates", async () => {
  const calls = [];
  const connectorRegistry = createConnectorRegistry({
    connectors: [createTestConnectorSpec()],
  });
  const listedConnector = connectorRegistry.list()[0];

  listedConnector.label = "Mutated";

  assert.equal(connectorRegistry.get(TEST_CONNECTOR_ID).label, "Test Connector");
  assert.deepEqual(
    connectorRegistry.listCapabilities().map((capability) => capability.id),
    [TEST_CONNECTOR_CAPABILITY_ID]
  );

  const capabilities = connectorRegistry.createCapabilities({
    executors: {
      [TEST_CONNECTOR_CAPABILITY_ID]: async ({
        accessScope: scopedAccess,
        connector,
        connectorCapability,
        executionBoundary,
        input,
        policy,
      }) => {
        calls.push({
          accessScope: scopedAccess,
          connector,
          connectorCapability,
          executionBoundary,
          input,
          policy,
        });

        return {
          capabilityId: connectorCapability.id,
          connectorId: connector.id,
          text: input.message,
        };
      },
    },
  });
  const capabilityRegistry = createCapabilityRegistry(capabilities);
  const description = capabilityRegistry.describe(TEST_CONNECTOR_CAPABILITY_ID);

  assert.equal(description.label, "Connector Echo");
  assert.equal(description.approvalPolicy.mode, "user_confirmation");
  assert.equal(description.privacyPolicy.externalCall, true);

  let approvalError = null;

  await assert.rejects(
    () =>
      capabilityRegistry.execute(TEST_CONNECTOR_CAPABILITY_ID, {
        accessScope,
        input: {
          apiKey: "sk-test-secret-value",
          message: "  hello connector  ",
        },
      }),
    (error) => {
      approvalError = error;

      return (
        isAgentRunInterrupt(error) &&
        error.detail.approvalGate.capabilityId === TEST_CONNECTOR_CAPABILITY_ID
      );
    }
  );
  assert.doesNotMatch(
    JSON.stringify(approvalError.detail.approvalGate.inputPreview),
    /sk-test-secret-value/
  );

  const result = await capabilityRegistry.execute(TEST_CONNECTOR_CAPABILITY_ID, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      apiKey: "sk-test-secret-value",
      message: "  hello connector  ",
    },
  });

  assert.deepEqual(result, {
    capabilityId: TEST_CONNECTOR_CAPABILITY_ID,
    connectorId: TEST_CONNECTOR_ID,
    text: "hello connector",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].accessScope, accessScope);
  assert.equal(calls[0].connector.id, TEST_CONNECTOR_ID);
  assert.equal(calls[0].connectorCapability.id, TEST_CONNECTOR_CAPABILITY_ID);
  assert.equal(calls[0].connectorCapability.replaySafety.stepType, "capability_call");
  assert.deepEqual(calls[0].input, {
    message: "hello connector",
  });
  assert.equal(calls[0].input.apiKey, undefined);
  assert.equal(calls[0].executionBoundary.sandbox.profile, "connector_external_read");
  assert.deepEqual(calls[0].executionBoundary.secrets.requiredRefs, [
    "TEST_CONNECTOR_API_TOKEN",
  ]);
  assert.doesNotMatch(JSON.stringify(calls[0].executionBoundary), /sk-test-secret-value/);
  assert.doesNotMatch(JSON.stringify(result), /sk-test-secret-value/);
  assert.equal(calls[0].policy.decision, "allowed");
  assert.ok(calls[0].policy.riskFlags.includes("external_call"));
});

test("connector registry rejects duplicate capability ids and disabled executors", async () => {
  const duplicateConnector = createTestConnectorSpec();

  duplicateConnector.id = "second_connector";

  assert.throws(
    () =>
      createConnectorRegistry({
        connectors: [createTestConnectorSpec(), duplicateConnector],
      }),
    /Duplicate AgentRAG connector capability id/
  );

  const connectorRegistry = createConnectorRegistry({
    connectors: [createTestConnectorSpec()],
  });
  const capabilityRegistry = createCapabilityRegistry(
    connectorRegistry.createCapabilities()
  );

  await assert.rejects(
    () =>
      capabilityRegistry.execute(TEST_CONNECTOR_CAPABILITY_ID, {
        accessScope,
        approval: {
          approved: true,
        },
        input: {
          message: "hello",
        },
      }),
    /Connector capability executor is not configured/
  );

  assert.deepEqual(createDefaultConnectorRegistry().list(), []);
});
