const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const REQUIRED_CAPABILITY_FIELDS = [
  "id",
  "version",
  "label",
  "inputSchema",
  "accessScope",
  "approvalPolicy",
  "privacyPolicy",
  "execute",
];

export const validateCapabilityContract = (capability = {}) => {
  const errors = [];

  for (const field of REQUIRED_CAPABILITY_FIELDS) {
    if (!(field in capability)) {
      errors.push(`missing ${field}`);
    }
  }

  if (!normalizeText(capability.id)) {
    errors.push("id must be non-empty");
  }

  if (!normalizeText(capability.version)) {
    errors.push("version must be non-empty");
  }

  if (!normalizeText(capability.label)) {
    errors.push("label must be non-empty");
  }

  if (typeof capability.execute !== "function") {
    errors.push("execute must be a function");
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
      errors.push(`${objectField} must be an object`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid AgentRAG capability contract for ${capability.id ?? "unknown"}: ${errors.join(", ")}.`
    );
  }

  return capability;
};

const validateUniqueCapabilities = (capabilities = []) => {
  const seen = new Set();

  for (const capability of capabilities) {
    validateCapabilityContract(capability);

    if (seen.has(capability.id)) {
      throw new Error(`Duplicate AgentRAG capability id: ${capability.id}`);
    }

    seen.add(capability.id);
  }
};

export const describeCapability = (capability = {}) => ({
  id: normalizeText(capability.id),
  version: normalizeText(capability.version),
  label: normalizeText(capability.label),
  inputSchema: normalizeRecord(capability.inputSchema),
  accessScope: normalizeRecord(capability.accessScope),
  approvalPolicy: normalizeRecord(capability.approvalPolicy),
  privacyPolicy: normalizeRecord(capability.privacyPolicy),
});

export const executeCapability = async (
  capability,
  { accessScope = {}, input = {}, services = {} } = {}
) => {
  validateCapabilityContract(capability);

  return capability.execute({
    accessScope,
    input,
    services,
  });
};

export const createCapabilityRegistry = (capabilities = []) => {
  validateUniqueCapabilities(capabilities);

  const capabilityMap = new Map(
    capabilities.map((capability) => [capability.id, capability])
  );

  return {
    describe: (capabilityId) => {
      const capability = capabilityMap.get(capabilityId);

      return capability ? describeCapability(capability) : null;
    },
    execute: async (capabilityId, payload = {}) => {
      const capability = capabilityMap.get(capabilityId);

      if (!capability) {
        throw new Error(`Unknown AgentRAG capability id: ${capabilityId}`);
      }

      return executeCapability(capability, payload);
    },
    get: (capabilityId) => capabilityMap.get(capabilityId) ?? null,
    list: () => [...capabilityMap.values()].map(describeCapability),
  };
};
