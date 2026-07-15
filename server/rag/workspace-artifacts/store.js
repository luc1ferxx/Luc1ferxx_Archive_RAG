import { getWorkspaceArtifactStoreProvider } from "../config.js";
import { isPostgresConfigured } from "../postgres.js";
import { createInMemoryWorkspaceArtifactStore } from "./memory-store.js";
import { createPostgresWorkspaceArtifactStore } from "./postgres-store.js";

export const WORKSPACE_ARTIFACT_STORE_PROVIDERS = Object.freeze({
  auto: "auto",
  memory: "memory",
  postgres: "postgres",
});

export const createDefaultWorkspaceArtifactStore = (options = {}) => {
  const provider =
    options.provider ?? getWorkspaceArtifactStoreProvider();
  const postgresConfigured =
    options.postgresConfigured ?? isPostgresConfigured();

  if (
    provider === WORKSPACE_ARTIFACT_STORE_PROVIDERS.postgres ||
    (provider === WORKSPACE_ARTIFACT_STORE_PROVIDERS.auto && postgresConfigured)
  ) {
    return createPostgresWorkspaceArtifactStore(options.postgres);
  }

  return createInMemoryWorkspaceArtifactStore(options.memory);
};
