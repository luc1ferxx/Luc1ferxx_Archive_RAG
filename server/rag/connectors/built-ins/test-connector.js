import {
  AGENT_CONNECTOR_SPEC_VERSION,
  AGENT_CONNECTOR_TYPE,
  CONNECTOR_REPLAY_STEP_TYPE,
} from "../schema.js";
import {
  STEP_REPLAY_APPROVAL_POLICIES,
  STEP_REPLAY_IDEMPOTENCY,
} from "../../agent-run-step-replay-safety.js";

export const TEST_CONNECTOR_ID = "test_connector";
export const TEST_CONNECTOR_CAPABILITY_ID = "connector.test_echo";

export const createTestConnectorSpec = () => ({
  id: TEST_CONNECTOR_ID,
  version: AGENT_CONNECTOR_SPEC_VERSION,
  type: AGENT_CONNECTOR_TYPE,
  label: "Test Connector",
  description:
    "Contract-only connector fixture for validating controlled capability mapping.",
  transport: {
    auth: {
      mode: "none",
    },
    serverId: "test-connector",
    type: "test",
  },
  capabilities: [
    {
      id: TEST_CONNECTOR_CAPABILITY_ID,
      version: AGENT_CONNECTOR_SPEC_VERSION,
      label: "Connector Echo",
      description: "Echoes a sanitized message through an injected executor.",
      connectorAction: {
        name: "echo",
        type: "mcp_tool",
      },
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: {
            type: "string",
          },
        },
      },
      accessScope: {
        required: true,
      },
      approvalPolicy: {
        mode: "user_confirmation",
        reason: "Connector Echo requires approval before execution.",
        userConfirmationRequired: true,
        writesWorkspace: false,
      },
      privacyPolicy: {
        externalCall: true,
        sanitizedInputFields: ["message"],
        storesResult: false,
      },
      replaySafety: {
        autoReplaySafe: false,
        idempotency: STEP_REPLAY_IDEMPOTENCY.capabilityDefined,
        replayApprovalPolicy:
          STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate,
        replayRequiresApproval: true,
        stepType: CONNECTOR_REPLAY_STEP_TYPE,
        summary:
          "Connector capabilities replay only through approved capability_call gates.",
      },
      sandboxPolicy: {
        allowNetwork: true,
        allowWorkspaceWrite: false,
        maxOutputBytes: 65536,
        profile: "connector_external_read",
        retryable: false,
        timeoutMs: 30000,
      },
      secretPolicy: {
        exposure: "refs_only",
        optionalSecretRefs: [],
        requiredSecretRefs: ["TEST_CONNECTOR_API_TOKEN"],
      },
    },
  ],
  metadata: {
    source: "test_fixture",
  },
});
