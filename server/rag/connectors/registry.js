import {
  createConnectorCapabilityAdapter,
  normalizeAgentConnectorSpec,
  validateAgentConnectorSpec,
} from "./schema.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const cloneConnectorSpec = (connector = {}) =>
  JSON.parse(JSON.stringify(connector ?? {}));

const buildRegistryError = ({ connector = {}, errors = [] } = {}) => {
  const error = new Error(
    `Invalid AgentRAG connector ${connector.id || "unknown"}: ${errors.join(", ")}`
  );

  error.errors = errors;
  return error;
};

const getConnectorCapabilityIds = (connector = {}) =>
  toArray(connector.capabilities).map((capability) =>
    normalizeText(capability.id)
  );

const resolveConnectorExecutor = ({ capability = {}, connector = {}, executors } = {}) => {
  if (typeof executors === "function") {
    return executors;
  }

  if (!executors || typeof executors !== "object") {
    return null;
  }

  const connectorId = normalizeText(connector.id);
  const capabilityId = normalizeText(capability.id);

  return (
    executors[`${connectorId}:${capabilityId}`] ??
    executors[capabilityId] ??
    executors[connectorId]?.[capabilityId] ??
    null
  );
};

export const createConnectorCapabilityAdapters = ({
  connectors = [],
  executors = {},
} = {}) =>
  toArray(connectors).flatMap((connector) => {
    const validation = validateAgentConnectorSpec(connector);

    if (!validation.valid) {
      throw buildRegistryError({
        connector: validation.spec,
        errors: validation.errors,
      });
    }

    return validation.spec.capabilities.map((capability) =>
      createConnectorCapabilityAdapter({
        capability,
        connector: validation.spec,
        executor: resolveConnectorExecutor({
          capability,
          connector: validation.spec,
          executors,
        }),
      })
    );
  });

export const createConnectorRegistry = ({ connectors = [] } = {}) => {
  const connectorMap = new Map();
  const capabilityIds = new Set();

  const register = (connector = {}) => {
    const validation = validateAgentConnectorSpec(connector);

    if (!validation.valid) {
      throw buildRegistryError({
        connector: validation.spec,
        errors: validation.errors,
      });
    }

    if (connectorMap.has(validation.spec.id)) {
      throw new Error(`Duplicate AgentRAG connector id: ${validation.spec.id}`);
    }

    for (const capabilityId of getConnectorCapabilityIds(validation.spec)) {
      if (capabilityIds.has(capabilityId)) {
        throw new Error(
          `Duplicate AgentRAG connector capability id: ${capabilityId}`
        );
      }
    }

    connectorMap.set(validation.spec.id, validation.spec);

    for (const capabilityId of getConnectorCapabilityIds(validation.spec)) {
      capabilityIds.add(capabilityId);
    }

    return cloneConnectorSpec(validation.spec);
  };

  for (const connector of connectors) {
    register(connector);
  }

  return {
    createCapabilities({ executors = {} } = {}) {
      return createConnectorCapabilityAdapters({
        connectors: this.list(),
        executors,
      });
    },

    get(connectorId) {
      const connector = connectorMap.get(normalizeText(connectorId));

      return connector ? cloneConnectorSpec(connector) : null;
    },

    list() {
      return [...connectorMap.values()].map(cloneConnectorSpec);
    },

    listCapabilities() {
      return this.list().flatMap((connector) =>
        connector.capabilities.map((capability) => ({
          connectorId: connector.id,
          connectorVersion: connector.version,
          id: capability.id,
          label: capability.label,
          replaySafety: capability.replaySafety,
          version: capability.version,
        }))
      );
    },

    register,
  };
};

export const createDefaultConnectorRegistry = () =>
  createConnectorRegistry({
    connectors: [],
  });

export {
  normalizeAgentConnectorSpec,
  validateAgentConnectorSpec,
} from "./schema.js";
