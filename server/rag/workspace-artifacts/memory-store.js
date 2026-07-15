import {
  ARTIFACT_STATUSES,
  buildWorkspaceArtifactScopeKey,
} from "./schema.js";

const normalizeText = (value) => String(value ?? "").trim();

const cloneArtifact = (artifact) =>
  artifact === null || artifact === undefined ? null : structuredClone(artifact);

export const createInMemoryWorkspaceArtifactStore = () => {
  const artifacts = new Map();
  const artifactKeysByIdempotency = new Map();

  const buildArtifactKey = ({ accessScope = {}, artifactId }) =>
    `${buildWorkspaceArtifactScopeKey(accessScope)}\u0000${normalizeText(artifactId)}`;

  return {
    initialize() {
      return true;
    },

    archiveArtifact({ accessScope = {}, artifactId, timestamp } = {}) {
      const artifactKey = buildArtifactKey({
        accessScope,
        artifactId,
      });
      const existingArtifact = artifacts.get(artifactKey);

      if (!existingArtifact) {
        return null;
      }

      if (existingArtifact.status === ARTIFACT_STATUSES.archived) {
        return cloneArtifact(existingArtifact);
      }

      const archivedArtifact = {
        ...existingArtifact,
        archivedAt: timestamp,
        status: ARTIFACT_STATUSES.archived,
        updatedAt: timestamp,
      };

      artifacts.set(artifactKey, cloneArtifact(archivedArtifact));

      return cloneArtifact(archivedArtifact);
    },

    createArtifact({ accessScope = {}, artifact } = {}) {
      const idempotencyKey = `${buildWorkspaceArtifactScopeKey(accessScope)}\u0000${normalizeText(
        artifact.idempotencyKey
      )}`;
      const existingArtifactKey = artifactKeysByIdempotency.get(idempotencyKey);

      if (existingArtifactKey) {
        return cloneArtifact(artifacts.get(existingArtifactKey));
      }

      const artifactKey = buildArtifactKey({
        accessScope,
        artifactId: artifact.artifactId,
      });

      artifacts.set(artifactKey, cloneArtifact(artifact));
      artifactKeysByIdempotency.set(idempotencyKey, artifactKey);

      return cloneArtifact(artifact);
    },

    getArtifact({ accessScope = {}, artifactId } = {}) {
      return cloneArtifact(
        artifacts.get(
          buildArtifactKey({
            accessScope,
            artifactId,
          })
        ) ?? null
      );
    },

    listArtifacts({
      accessScope = {},
      artifactType = "",
      limit = 50,
      offset = 0,
      status = "active",
    } = {}) {
      const scopeKey = buildWorkspaceArtifactScopeKey(accessScope);
      const matches = [...artifacts.values()]
        .filter(
          (artifact) =>
            buildWorkspaceArtifactScopeKey({
              userId: artifact.ownerUserId,
              workspaceId: artifact.workspaceId,
            }) === scopeKey &&
            (!artifactType || artifact.artifactType === artifactType) &&
            (!status || artifact.status === status)
        )
        .sort(
          (left, right) =>
            String(right.createdAt).localeCompare(String(left.createdAt)) ||
            String(left.artifactId).localeCompare(String(right.artifactId))
        );

      return {
        artifacts: matches.slice(offset, offset + limit).map(cloneArtifact),
        limit,
        offset,
        total: matches.length,
      };
    },
  };
};
