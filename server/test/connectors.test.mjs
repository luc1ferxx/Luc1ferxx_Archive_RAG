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
  assert.doesNotThrow(() => JSON.stringify(validation.spec));
});

test("connector validation rejects approval, replay, and privacy bypasses", () => {
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
        input,
        policy,
      }) => {
        calls.push({
          accessScope: scopedAccess,
          connector,
          connectorCapability,
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

  const result = await capabilityRegistry.execute(TEST_CONNECTOR_CAPABILITY_ID, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
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
