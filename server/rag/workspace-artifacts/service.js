import { randomUUID } from "node:crypto";

import {
  normalizeWorkspaceArtifactAccessScope,
  normalizeWorkspaceArtifact,
  normalizeWorkspaceArtifactListQuery,
} from "./schema.js";
import { createInMemoryWorkspaceArtifactStore } from "./memory-store.js";
import { toWorkspaceArtifactDownload } from "./projections.js";

export const createWorkspaceArtifactService = ({
  createArtifactId = randomUUID,
  now = () => new Date().toISOString(),
  store = createInMemoryWorkspaceArtifactStore(),
} = {}) => ({
  initialize() {
    return store.initialize?.() ?? true;
  },

  async createArtifact({ accessScope = {}, artifact = {} } = {}) {
    const normalizedAccessScope = normalizeWorkspaceArtifactAccessScope(
      accessScope
    );
    const normalizedArtifact = normalizeWorkspaceArtifact({
      accessScope: normalizedAccessScope,
      artifact,
      artifactId: createArtifactId(),
      timestamp: now(),
    });

    return store.createArtifact({
      accessScope: normalizedAccessScope,
      artifact: normalizedArtifact,
    });
  },

  async archiveArtifact({ accessScope = {}, artifactId } = {}) {
    return store.archiveArtifact({
      accessScope: normalizeWorkspaceArtifactAccessScope(accessScope),
      artifactId,
      timestamp: now(),
    });
  },

  async getArtifact({ accessScope = {}, artifactId } = {}) {
    return store.getArtifact({
      accessScope: normalizeWorkspaceArtifactAccessScope(accessScope),
      artifactId,
    });
  },

  async getArtifactDownload({ accessScope = {}, artifactId } = {}) {
    const artifact = await store.getArtifact({
      accessScope: normalizeWorkspaceArtifactAccessScope(accessScope),
      artifactId,
    });

    return artifact ? toWorkspaceArtifactDownload(artifact) : null;
  },

  async listArtifacts({
    accessScope = {},
    artifactType = "",
    limit = 50,
    offset = 0,
    status = "active",
  } = {}) {
    const query = normalizeWorkspaceArtifactListQuery({
      artifactType,
      limit,
      offset,
      status,
    });

    return store.listArtifacts({
      accessScope: normalizeWorkspaceArtifactAccessScope(accessScope),
      ...query,
    });
  },
});
