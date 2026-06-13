import { getTaskStoreProvider } from "./config.js";
import { isPostgresConfigured } from "./postgres.js";
import { createPostgresTaskStore } from "./postgres-task-store.js";
import { createInMemoryTaskStore } from "./tasks.js";

export const TASK_STORE_PROVIDERS = Object.freeze({
  auto: "auto",
  memory: "memory",
  postgres: "postgres",
});

export const createDefaultTaskStore = (options = {}) => {
  const provider = options.provider ?? getTaskStoreProvider();

  if (
    provider === TASK_STORE_PROVIDERS.postgres ||
    (provider === TASK_STORE_PROVIDERS.auto && isPostgresConfigured())
  ) {
    return createPostgresTaskStore(options.postgres);
  }

  return createInMemoryTaskStore(options.memory);
};
