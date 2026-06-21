import {
  getAgentRunStoreConfigStatus,
  getAgentRunStoreProvider,
} from "./config.js";
import { createInMemoryAgentRunStore } from "./agent-runs.js";
import { createPostgresAgentRunStore } from "./postgres-agent-run-store.js";

export const AGENT_RUN_STORE_PROVIDERS = Object.freeze({
  auto: "auto",
  memory: "memory",
  postgres: "postgres",
});

export const createDefaultAgentRunStore = (options = {}) => {
  const provider = options.provider ?? getAgentRunStoreProvider();
  const configStatus = getAgentRunStoreConfigStatus({ provider });

  if (configStatus.backend === AGENT_RUN_STORE_PROVIDERS.postgres) {
    return createPostgresAgentRunStore(options.postgres);
  }

  return createInMemoryAgentRunStore(options.memory);
};
