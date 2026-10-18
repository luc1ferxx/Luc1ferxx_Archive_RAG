import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACT_STATUSES,
  buildWorkspaceArtifactScopeKey,
} from "./schema.js";
import {
  isRetentionExpired,
  normalizeRetentionBatchLimit,
  normalizeRetentionCutoffs,
} from "../retention-sql.js";
import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";
import { summarizeTenantRecords, tenantSelectorMatches } from "../tenant-records.js";

const cloneArtifact = (artifact) =>
  artifact === null || artifact === undefined ? null : structuredClone(artifact);

export const createInMemoryWorkspaceArtifactStore = () => {
  const artifacts = new Map();
  const artifactKeysByIdempotency = new Map();

  const buildArtifactKey = ({ accessScope = {}, artifactId }) =>
    `${buildWorkspaceArtifactScopeKey(accessScope)}\u0000${normalizeText(artifactId)}`;

  // The tenant erase and export (rag/tenant-records.js).
  const listTenantArtifacts = (selector) =>
    [...artifacts.entries()].filter(([, artifact]) =>
      tenantSelectorMatches(selector, {
        userId: artifact.ownerUserId,
        workspaceId: artifact.workspaceId,
      })
    );

  return {
    initialize() {
      return true;
    },

    countTenantRecords(selector) {
      return summarizeTenantRecords(this.listTenantRecords(selector), ["workspace_artifacts"]);
    },

    listTenantRecords(selector) {
      return listTenantArtifacts(selector).map(([, artifact]) => ({
        record: cloneArtifact(artifact),
        table: "workspace_artifacts",
      }));
    },

    deleteTenantRecords(selector) {
      const matched = listTenantArtifacts(selector);
      const removedKeys = new Set(matched.map(([key]) => key));

      for (const key of removedKeys) {
        artifacts.delete(key);
      }

      for (const [idempotencyKey, artifactKey] of artifactKeysByIdempotency) {
        if (removedKeys.has(artifactKey)) {
          artifactKeysByIdempotency.delete(idempotencyKey);
        }
      }

      return { workspace_artifacts: { deleted: matched.length } };
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

    // The PostgreSQL store's contract (postgres-store.js).
    listArtifactsReferencingDocuments({
      accessScope = {},
      after = null,
      docIds = [],
      limit = 25,
      needles = [],
    } = {}) {
      const ids = new Set((Array.isArray(docIds) ? docIds : []).map(normalizeText).filter(Boolean));
      const values = (Array.isArray(needles) ? needles : []).map(String).filter(Boolean);
      const scoped = Boolean(normalizeText(accessScope.userId) || normalizeText(accessScope.workspaceId));
      const scopeKey = buildWorkspaceArtifactScopeKey(accessScope);
      const pageSize = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 25));
      const orderKey = (artifact) =>
        `${buildWorkspaceArtifactScopeKey({ userId: artifact.ownerUserId, workspaceId: artifact.workspaceId })}\u0000${artifact.artifactId}`;
      const afterKey = after
        ? `${buildWorkspaceArtifactScopeKey(after)}\u0000${normalizeText(after.artifactId)}`
        : null;

      if (ids.size === 0) {
        return { artifacts: [], next: null };
      }

      const matches = [...artifacts.values()]
        .filter(
          (artifact) =>
            !scoped ||
            buildWorkspaceArtifactScopeKey({ userId: artifact.ownerUserId, workspaceId: artifact.workspaceId }) ===
              scopeKey
        )
        .filter((artifact) => afterKey === null || orderKey(artifact) > afterKey)
        .filter((artifact) => {
          if ((artifact.docIds ?? []).some((docId) => ids.has(docId))) {
            return true;
          }

          const serialized = JSON.stringify([artifact.citationManifest ?? [], artifact.payload ?? {}]);

          return values.some((needle) => serialized.includes(needle));
        })
        .sort((left, right) => (orderKey(left) < orderKey(right) ? -1 : 1))
        .slice(0, pageSize);
      const last = matches.at(-1);

      return {
        artifacts: matches.map(cloneArtifact),
        next:
          matches.length === pageSize && last
            ? { artifactId: last.artifactId, userId: last.ownerUserId, workspaceId: last.workspaceId }
            : null,
      };
    },

    markArtifactSourceDeleted({
      accessScope = {},
      artifactId,
      citationManifest = [],
      content = "",
      deletedDocIds = [],
      payload = {},
      previous = {},
      timestamp,
    } = {}) {
      const artifactKey = buildArtifactKey({ accessScope, artifactId });
      const existingArtifact = artifacts.get(artifactKey);

      if (
        !existingArtifact ||
        !isDeepStrictEqual(existingArtifact.citationManifest ?? [], previous.citationManifest ?? []) ||
        String(existingArtifact.content ?? "") !== String(previous.content ?? "") ||
        !isDeepStrictEqual(existingArtifact.payload ?? {}, previous.payload ?? {})
      ) {
        return null;
      }

      const markedArtifact = {
        ...existingArtifact,
        citationManifest: structuredClone(citationManifest ?? []),
        content: String(content ?? ""),
        payload: structuredClone(payload ?? {}),
        sourceDeleted: true,
        sourceDeletedDocIds: [
          ...new Set([
            ...(existingArtifact.sourceDeletedDocIds ?? []),
            ...(Array.isArray(deletedDocIds) ? deletedDocIds : []).map(normalizeText).filter(Boolean),
          ]),
        ].sort(),
        updatedAt: timestamp,
      };

      artifacts.set(artifactKey, cloneArtifact(markedArtifact));
      return cloneArtifact(markedArtifact);
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

    // Retention (rag/retention.js), as the PostgreSQL store: at most `limit`
    // archived artifacts archived before their workspace's cutoff, oldest
    // first, together with their idempotency entries.
    deleteExpired({ cutoff, limit, workspaceCutoffs = [] } = {}) {
      const normalized = normalizeRetentionCutoffs({ cutoff, workspaceCutoffs });
      const archivedAt = (artifact) => artifact.archivedAt || artifact.updatedAt;
      const expiredKeys = [...artifacts.entries()]
        .filter(
          ([, artifact]) =>
            artifact.status === ARTIFACT_STATUSES.archived &&
            isRetentionExpired(normalized, {
              timestamp: archivedAt(artifact),
              workspaceId: artifact.workspaceId,
            })
        )
        .sort(
          ([, left], [, right]) =>
            Date.parse(archivedAt(left)) - Date.parse(archivedAt(right)) ||
            String(left.artifactId).localeCompare(String(right.artifactId))
        )
        .slice(0, normalizeRetentionBatchLimit(limit))
        .map(([artifactKey]) => artifactKey);
      const expired = new Set(expiredKeys);

      for (const [idempotencyKey, artifactKey] of artifactKeysByIdempotency) {
        if (expired.has(artifactKey)) {
          artifactKeysByIdempotency.delete(idempotencyKey);
        }
      }

      expiredKeys.forEach((artifactKey) => artifacts.delete(artifactKey));

      return { acquired: true, deleted: expiredKeys.length };
    },
  };
};
