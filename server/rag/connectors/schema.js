import {
  STEP_REPLAY_APPROVAL_POLICIES,
  STEP_REPLAY_IDEMPOTENCY,
} from "../agent-run-step-replay-safety.js";
import { validateCapabilityContract } from "../capabilities/registry.js";
import { normalizeText, toArray } from "../capabilities/shared.js";

export const AGENT_CONNECTOR_TYPE = "agent_connector";
export const AGENT_CONNECTOR_SPEC_VERSION = "1.0.0";
export const CONNECTOR_CAPABILITY_SOURCE = "connector";

export const CONNECTOR_REPLAY_STEP_TYPE = "capability_call";

const APPROVAL_MODES = new Set([
  "approval_required",
  "manual",
  "user_confirmation",
]);

const MAX_TEXT_LENGTH = 320;

const normalizeBoundedText = (value, maxLength = MAX_TEXT_LENGTH) =>
  normalizeText(value).slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const cloneJson = (value, fallback = {}) =>
  JSON.parse(JSON.stringify(value ?? fallback));

const normalizeTextList = (value, maxLength = MAX_TEXT_LENGTH) =>
  toArray(value)
    .map((item) => normalizeBoundedText(item, maxLength))
    .filter(Boolean);

const normalizeTransport = (transport = {}) => {
  const transportRecord = normalizeRecord(transport);

  return {
    auth: {
      mode: normalizeBoundedText(transportRecord.auth?.mode, 80) || "none",
    },
    baseUrl: normalizeBoundedText(transportRecord.baseUrl, 500),
    serverId: normalizeBoundedText(transportRecord.serverId, 120),
    type: normalizeBoundedText(transportRecord.type, 80),
  };
};

const normalizeConnectorAction = (action = {}) => {
  const actionRecord = normalizeRecord(action);

  return {
    name: normalizeBoundedText(actionRecord.name, 160),
    type: normalizeBoundedText(actionRecord.type, 80),
  };
};

const normalizeReplaySafety = (replaySafety = {}) => {
  const replayRecord = normalizeRecord(replaySafety);

  return {
    autoReplaySafe: replayRecord.autoReplaySafe === true,
    idempotency:
      normalizeBoundedText(replayRecord.idempotency, 120) ||
      STEP_REPLAY_IDEMPOTENCY.capabilityDefined,
    replayApprovalPolicy:
      normalizeBoundedText(replayRecord.replayApprovalPolicy, 120) ||
      STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate,
    replayRequiresApproval: replayRecord.replayRequiresApproval !== false,
    stepType:
      normalizeBoundedText(replayRecord.stepType, 80) ||
      CONNECTOR_REPLAY_STEP_TYPE,
    summary: normalizeBoundedText(replayRecord.summary, 500),
  };
};

export const normalizeConnectorCapabilitySpec = (
  capability = {},
  connector = {}
) => {
  const capabilityRecord = normalizeRecord(capability);
  const connectorRecord = normalizeRecord(connector);

  return {
    accessScope: cloneJson(capabilityRecord.accessScope),
    approvalPolicy: cloneJson(capabilityRecord.approvalPolicy),
    connectorAction: normalizeConnectorAction(capabilityRecord.connectorAction),
    description: normalizeBoundedText(capabilityRecord.description, 500),
    id: normalizeBoundedText(capabilityRecord.id, 160),
    inputSchema: cloneJson(capabilityRecord.inputSchema),
    label: normalizeBoundedText(capabilityRecord.label, 160),
    privacyPolicy: cloneJson(capabilityRecord.privacyPolicy),
    replaySafety: normalizeReplaySafety(capabilityRecord.replaySafety),
    source: {
      connectorId: normalizeBoundedText(connectorRecord.id, 120),
      connectorVersion: normalizeBoundedText(connectorRecord.version, 40),
      type: CONNECTOR_CAPABILITY_SOURCE,
    },
    version:
      normalizeBoundedText(capabilityRecord.version, 40) ||
      normalizeBoundedText(connectorRecord.version, 40) ||
      AGENT_CONNECTOR_SPEC_VERSION,
  };
};

export const normalizeAgentConnectorSpec = (connector = {}) => {
  const connectorRecord = normalizeRecord(connector);
  const normalizedConnector = {
    capabilities: [],
    description: normalizeBoundedText(connectorRecord.description, 500),
    id: normalizeBoundedText(connectorRecord.id, 120),
    label: normalizeBoundedText(connectorRecord.label, 160),
    metadata: cloneJson(connectorRecord.metadata),
    transport: normalizeTransport(connectorRecord.transport),
    type: normalizeBoundedText(connectorRecord.type, 80) || AGENT_CONNECTOR_TYPE,
    version:
      normalizeBoundedText(connectorRecord.version, 40) ||
      AGENT_CONNECTOR_SPEC_VERSION,
  };

  return {
    ...normalizedConnector,
    capabilities: toArray(connectorRecord.capabilities).map((capability) =>
      normalizeConnectorCapabilitySpec(capability, normalizedConnector)
    ),
  };
};

const requiresApproval = (approvalPolicy = {}) => {
  const policy = normalizeRecord(approvalPolicy);
  const mode = normalizeBoundedText(policy.mode, 80).toLowerCase();

  return (
    policy.requiresApproval === true ||
    policy.userConfirmationRequired === true ||
    APPROVAL_MODES.has(mode)
  );
};

const validateConnectorCapability = ({ capability = {}, errors = [] } = {}) => {
  if (!capability.id) {
    errors.push("Connector capability id is required.");
  }

  if (!capability.label) {
    errors.push(`Connector capability ${capability.id || "unknown"} label is required.`);
  }

  for (const objectField of [
    "inputSchema",
    "accessScope",
    "approvalPolicy",
    "privacyPolicy",
  ]) {
    if (
      !capability[objectField] ||
      typeof capability[objectField] !== "object" ||
      Array.isArray(capability[objectField])
    ) {
      errors.push(
        `Connector capability ${capability.id || "unknown"} ${objectField} must be an object.`
      );
    }
  }

  if (!requiresApproval(capability.approvalPolicy)) {
    errors.push(
      `Connector capability ${capability.id || "unknown"} must require user approval.`
    );
  }

  if (
    capability.privacyPolicy.externalCall === true &&
    normalizeTextList(capability.privacyPolicy.sanitizedInputFields, 120)
      .length === 0
  ) {
    errors.push(
      `Connector capability ${capability.id || "unknown"} external calls require sanitizedInputFields.`
    );
  }

  if (capability.replaySafety.stepType !== CONNECTOR_REPLAY_STEP_TYPE) {
    errors.push(
      `Connector capability ${capability.id || "unknown"} must replay through ${CONNECTOR_REPLAY_STEP_TYPE}.`
    );
  }

  if (capability.replaySafety.autoReplaySafe) {
    errors.push(
      `Connector capability ${capability.id || "unknown"} must not be marked auto replay safe.`
    );
  }

  if (
    capability.replaySafety.replayRequiresApproval !== true ||
    capability.replaySafety.replayApprovalPolicy !==
      STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate
  ) {
    errors.push(
      `Connector capability ${capability.id || "unknown"} must replay only through approved capability gates.`
    );
  }

};

export const validateAgentConnectorSpec = (connector = {}) => {
  const spec = normalizeAgentConnectorSpec(connector);
  const errors = [];
  const capabilityIds = new Set();

  if (!spec.id) {
    errors.push("Connector id is required.");
  }

  if (spec.type !== AGENT_CONNECTOR_TYPE) {
    errors.push(`Connector type must be ${AGENT_CONNECTOR_TYPE}.`);
  }

  if (!spec.version) {
    errors.push("Connector version is required.");
  }

  if (!spec.label) {
    errors.push("Connector label is required.");
  }

  if (!spec.transport.type) {
    errors.push("Connector transport.type is required.");
  }

  if (spec.capabilities.length === 0) {
    errors.push("Connector requires at least one capability.");
  }

  for (const capability of spec.capabilities) {
    validateConnectorCapability({
      capability,
      errors,
    });

    if (!capability.id) {
      continue;
    }

    if (capabilityIds.has(capability.id)) {
      errors.push(`Connector capability id must be unique: ${capability.id}`);
    }

    capabilityIds.add(capability.id);
  }

  return {
    errors,
    spec,
    valid: errors.length === 0,
  };
};

const compactConnectorForExecutor = (connector = {}) => ({
  id: normalizeBoundedText(connector.id, 120),
  label: normalizeBoundedText(connector.label, 160),
  transport: cloneJson(connector.transport),
  type: normalizeBoundedText(connector.type, 80),
  version: normalizeBoundedText(connector.version, 40),
});

const compactConnectorCapabilityForExecutor = (capability = {}) => ({
  connectorAction: cloneJson(capability.connectorAction),
  id: normalizeBoundedText(capability.id, 160),
  label: normalizeBoundedText(capability.label, 160),
  replaySafety: cloneJson(capability.replaySafety),
  source: cloneJson(capability.source),
  version: normalizeBoundedText(capability.version, 40),
});

const buildMissingExecutor = (capabilityId) => async () => {
  throw new Error(
    `Connector capability executor is not configured: ${capabilityId}`
  );
};

export const createConnectorCapabilityAdapter = ({
  capability = {},
  connector = {},
  executor,
} = {}) => {
  const normalizedConnector = normalizeAgentConnectorSpec(connector);
  const normalizedCapability = normalizeConnectorCapabilitySpec(
    capability,
    normalizedConnector
  );
  const executeConnector =
    typeof executor === "function"
      ? executor
      : buildMissingExecutor(normalizedCapability.id);
  const capabilityContract = {
    accessScope: cloneJson(normalizedCapability.accessScope),
    approvalPolicy: cloneJson(normalizedCapability.approvalPolicy),
    connector: {
      action: cloneJson(normalizedCapability.connectorAction),
      id: normalizedConnector.id,
      replaySafety: cloneJson(normalizedCapability.replaySafety),
      transport: cloneJson(normalizedConnector.transport),
      version: normalizedConnector.version,
    },
    inputSchema: cloneJson(normalizedCapability.inputSchema),
    label: normalizedCapability.label,
    privacyPolicy: cloneJson(normalizedCapability.privacyPolicy),
    source: cloneJson(normalizedCapability.source),
    version: normalizedCapability.version,
    id: normalizedCapability.id,
    execute: async ({ accessScope = {}, input = {}, policy = {}, services = {} } = {}) => {
      return executeConnector({
        accessScope,
        connector: compactConnectorForExecutor(normalizedConnector),
        connectorCapability: compactConnectorCapabilityForExecutor(
          normalizedCapability
        ),
        input,
        policy,
        services,
      });
    },
  };

  return validateCapabilityContract(capabilityContract);
};
