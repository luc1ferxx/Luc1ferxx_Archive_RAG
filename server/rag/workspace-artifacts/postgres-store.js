import { getWorkspaceArtifactsPostgresTable } from "../config.js";
import { runPostgresMigrations } from "../db-migrations.js";
import { queryPostgres } from "../postgres.js";
import { createPostgresTenantRecordMethods } from "../tenant-records.js";
import {
  buildRetentionLockKey,
  normalizeRetentionBatchLimit,
  normalizeRetentionCutoffs,
  readRetentionLockAcquired,
  renderRetentionPreludeCtes,
} from "../retention-sql.js";
import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureTableName = (tableName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `WORKSPACE_ARTIFACTS_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const parseJsonValue = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toIsoText = (value) => {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? normalizeText(value) : date.toISOString();
};

const artifactSelectColumns = `
  owner_user_id,
  workspace_id,
  artifact_id,
  artifact_type,
  version,
  title,
  status,
  format,
  mime_type,
  file_name,
  content,
  payload,
  doc_ids,
  citation_manifest,
  source_task_id,
  source_run_id,
  idempotency_key,
  created_at,
  updated_at,
  archived_at,
  source_deleted,
  source_deleted_doc_ids
`;

const mapRowToArtifact = (row = {}) => ({
  archivedAt: toIsoText(row.archived_at),
  artifactId: normalizeText(row.artifact_id),
  artifactType: normalizeText(row.artifact_type),
  citationManifest: parseJsonValue(row.citation_manifest, []),
  content: String(row.content ?? ""),
  createdAt: toIsoText(row.created_at),
  docIds: parseJsonValue(row.doc_ids, []),
  fileName: normalizeText(row.file_name),
  format: normalizeText(row.format),
  idempotencyKey: normalizeText(row.idempotency_key),
  mimeType: normalizeText(row.mime_type),
  ownerUserId: normalizeText(row.owner_user_id),
  payload: parseJsonValue(row.payload, {}),
  sourceRunId: normalizeText(row.source_run_id),
  sourceTaskId: normalizeText(row.source_task_id),
  status: normalizeText(row.status),
  title: normalizeText(row.title),
  updatedAt: toIsoText(row.updated_at),
  version: normalizeText(row.version),
  workspaceId: normalizeText(row.workspace_id),
  // Migration 040: set only once a source document was deleted under
  // DOCUMENT_DELETE_REDACTION=on, so every other artifact maps as before.
  ...(row.source_deleted === true
    ? {
        sourceDeleted: true,
        sourceDeletedDocIds: parseJsonValue(row.source_deleted_doc_ids, []),
      }
    : {}),
});

export const createPostgresWorkspaceArtifactStore = ({
  query = queryPostgres,
  runMigrations = runPostgresMigrations,
  tableName = getWorkspaceArtifactsPostgresTable(),
} = {}) => {
  const artifactsTable = ensureTableName(tableName);
  let initialized = false;

  const initialize = async () => {
    if (initialized) {
      return true;
    }

    await runMigrations();
    initialized = true;
    return true;
  };

  const findByIdempotencyKey = async ({ accessScope = {}, key } = {}) => {
    const result = await query(
      `
        SELECT ${artifactSelectColumns}
        FROM ${artifactsTable}
        WHERE owner_user_id = $1
          AND workspace_id = $2
          AND idempotency_key = $3
        LIMIT 1
      `,
      [accessScope.userId ?? "", accessScope.workspaceId ?? "", key]
    );

    return result.rows[0] ? mapRowToArtifact(result.rows[0]) : null;
  };

  return {
    // The tenant erase and export (rag/tenant-records.js).
    ...createPostgresTenantRecordMethods({
      initialize,
      query,
      tables: () => [
        {
          keyColumns: ["owner_user_id", "workspace_id", "artifact_id"],
          name: "workspace_artifacts",
          pageSize: 50,
          table: artifactsTable,
          userColumn: "owner_user_id",
        },
      ],
    }),

    async initialize() {
      return initialize();
    },

    async archiveArtifact({ accessScope = {}, artifactId, timestamp } = {}) {
      await initialize();

      const result = await query(
        `
          UPDATE ${artifactsTable}
          SET
            status = 'archived',
            archived_at = COALESCE(archived_at, $4::timestamptz),
            updated_at = CASE
              WHEN archived_at IS NULL THEN $4::timestamptz
              ELSE updated_at
            END
          WHERE owner_user_id = $1
            AND workspace_id = $2
            AND artifact_id = $3
          RETURNING ${artifactSelectColumns}
        `,
        [
          accessScope.userId ?? "",
          accessScope.workspaceId ?? "",
          normalizeText(artifactId),
          timestamp,
        ]
      );

      return result.rows[0] ? mapRowToArtifact(result.rows[0]) : null;
    },

    async createArtifact({ accessScope = {}, artifact } = {}) {
      await initialize();

      const result = await query(
        `
          INSERT INTO ${artifactsTable} (
            owner_user_id,
            workspace_id,
            artifact_id,
            artifact_type,
            version,
            title,
            status,
            format,
            mime_type,
            file_name,
            content,
            payload,
            doc_ids,
            citation_manifest,
            source_task_id,
            source_run_id,
            idempotency_key,
            created_at,
            updated_at,
            archived_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17,
            $18::timestamptz, $19::timestamptz, $20::timestamptz
          )
          ON CONFLICT (owner_user_id, workspace_id, idempotency_key)
          DO NOTHING
          RETURNING ${artifactSelectColumns}
        `,
        [
          artifact.ownerUserId,
          artifact.workspaceId,
          artifact.artifactId,
          artifact.artifactType,
          artifact.version,
          artifact.title,
          artifact.status,
          artifact.format,
          artifact.mimeType,
          artifact.fileName,
          artifact.content,
          JSON.stringify(artifact.payload ?? {}),
          JSON.stringify(artifact.docIds ?? []),
          JSON.stringify(artifact.citationManifest ?? []),
          artifact.sourceTaskId,
          artifact.sourceRunId,
          artifact.idempotencyKey,
          artifact.createdAt,
          artifact.updatedAt,
          artifact.archivedAt,
        ]
      );

      if (result.rows[0]) {
        return mapRowToArtifact(result.rows[0]);
      }

      return findByIdempotencyKey({
        accessScope,
        key: artifact.idempotencyKey,
      });
    },

    /**
     * Artifacts that name one of `docIds` in doc_ids, or as a `"docId": ...`
     * member (`needles`, rag/document-deletion-redaction.js) of their
     * citation manifest or payload, in key order from `after` (the previous
     * page's `next`). Exactly the scope's (user, workspace) pair, or every
     * pair for a scope naming neither (the unscoped context). Archived ones
     * included: they still hold the text.
     */
    async listArtifactsReferencingDocuments({
      accessScope = {},
      after = null,
      docIds = [],
      limit = 25,
      needles = [],
    } = {}) {
      await initialize();

      const ids = (Array.isArray(docIds) ? docIds : []).map(normalizeText).filter(Boolean);

      if (ids.length === 0) {
        return { artifacts: [], next: null };
      }

      const userId = normalizeText(accessScope.userId);
      const workspaceId = normalizeText(accessScope.workspaceId);
      const pageSize = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 25));
      const result = await query(
        `
          SELECT ${artifactSelectColumns}
          FROM ${artifactsTable}
          WHERE ($1::boolean = FALSE OR (owner_user_id = $2 AND workspace_id = $3))
            AND ($4::text IS NULL
              OR (owner_user_id, workspace_id, artifact_id) > ($4::text, $5::text, $6::text))
            AND (
              doc_ids ?| $7::text[]
              OR EXISTS (
                SELECT 1
                FROM unnest($8::text[]) AS needle(value)
                WHERE strpos(citation_manifest::text, needle.value) > 0
                   OR strpos(payload::text, needle.value) > 0
              )
            )
          ORDER BY owner_user_id, workspace_id, artifact_id
          LIMIT $9
        `,
        [
          Boolean(userId || workspaceId),
          userId,
          workspaceId,
          after ? normalizeText(after.userId) : null,
          after ? normalizeText(after.workspaceId) : null,
          after ? normalizeText(after.artifactId) : null,
          ids,
          (Array.isArray(needles) ? needles : []).map(String).filter(Boolean),
          pageSize,
        ]
      );
      const artifacts = result.rows.map(mapRowToArtifact);
      const last = artifacts.at(-1);

      return {
        artifacts,
        next:
          artifacts.length === pageSize && last
            ? { artifactId: last.artifactId, userId: last.ownerUserId, workspaceId: last.workspaceId }
            : null,
      };
    },

    /**
     * Writes an artifact's redacted citation manifest, content and payload
     * and marks it source_deleted with `deletedDocIds` added to its list
     * (migration 040). Compare-and-set on the three values `previous` holds,
     * so a concurrent redaction is never overwritten with text it removed:
     * null when they moved (the caller reads the artifact again) or the
     * artifact is gone.
     */
    async markArtifactSourceDeleted({
      accessScope = {},
      artifactId,
      citationManifest = [],
      content = "",
      deletedDocIds = [],
      payload = {},
      previous = {},
      timestamp,
    } = {}) {
      await initialize();

      const result = await query(
        `
          UPDATE ${artifactsTable}
          SET
            citation_manifest = $4::jsonb,
            content = $5,
            payload = $6::jsonb,
            source_deleted = TRUE,
            source_deleted_doc_ids = (
              SELECT COALESCE(jsonb_agg(DISTINCT merged.value ORDER BY merged.value), '[]'::jsonb)
              FROM jsonb_array_elements_text(source_deleted_doc_ids || $7::jsonb) AS merged(value)
            ),
            updated_at = $8::timestamptz
          WHERE owner_user_id = $1
            AND workspace_id = $2
            AND artifact_id = $3
            AND citation_manifest = $9::jsonb
            AND content = $10
            AND payload = $11::jsonb
          RETURNING ${artifactSelectColumns}
        `,
        [
          normalizeText(accessScope.userId),
          normalizeText(accessScope.workspaceId),
          normalizeText(artifactId),
          JSON.stringify(citationManifest ?? []),
          String(content ?? ""),
          JSON.stringify(payload ?? {}),
          JSON.stringify((Array.isArray(deletedDocIds) ? deletedDocIds : []).map(normalizeText).filter(Boolean)),
          timestamp,
          JSON.stringify(previous.citationManifest ?? []),
          String(previous.content ?? ""),
          JSON.stringify(previous.payload ?? {}),
        ]
      );

      return result.rows[0] ? mapRowToArtifact(result.rows[0]) : null;
    },

    async getArtifact({ accessScope = {}, artifactId } = {}) {
      await initialize();

      const result = await query(
        `
          SELECT ${artifactSelectColumns}
          FROM ${artifactsTable}
          WHERE owner_user_id = $1
            AND workspace_id = $2
            AND artifact_id = $3
          LIMIT 1
        `,
        [
          accessScope.userId ?? "",
          accessScope.workspaceId ?? "",
          normalizeText(artifactId),
        ]
      );

      return result.rows[0] ? mapRowToArtifact(result.rows[0]) : null;
    },

    async listArtifacts({
      accessScope = {},
      artifactType = "",
      limit = 50,
      offset = 0,
      status = "active",
    } = {}) {
      await initialize();

      const values = [
        accessScope.userId ?? "",
        accessScope.workspaceId ?? "",
        normalizeText(artifactType),
        normalizeText(status),
      ];
      const countResult = await query(
        `
          SELECT COUNT(*) AS total
          FROM ${artifactsTable}
          WHERE owner_user_id = $1
            AND workspace_id = $2
            AND ($3 = '' OR artifact_type = $3)
            AND ($4 = '' OR status = $4)
        `,
        values
      );
      const result = await query(
        `
          SELECT ${artifactSelectColumns}
          FROM ${artifactsTable}
          WHERE owner_user_id = $1
            AND workspace_id = $2
            AND ($3 = '' OR artifact_type = $3)
            AND ($4 = '' OR status = $4)
          ORDER BY created_at DESC, artifact_id ASC
          LIMIT $5 OFFSET $6
        `,
        [...values, limit, offset]
      );

      return {
        artifacts: result.rows.map(mapRowToArtifact),
        limit,
        offset,
        total: Number(countResult.rows[0]?.total ?? 0) || 0,
      };
    },

    /**
     * Retention (rag/retention.js): deletes at most `limit` ARCHIVED
     * artifacts of every tenant whose archive time (archived_at, else
     * updated_at) is before their workspace's cutoff. An active artifact is a
     * deliverable someone kept and is never deleted by age; archiving it is
     * the explicit step that starts its retention clock. A row another
     * transaction holds is skipped (SKIP LOCKED). One statement, holding the
     * table's advisory try-lock while it runs. System work: the caller binds
     * runAsDatabaseSystem. Resolves to { acquired, deleted }.
     */
    async deleteExpired({ cutoff, limit, workspaceCutoffs = [] } = {}) {
      await initialize();

      const normalized = normalizeRetentionCutoffs({ cutoff, workspaceCutoffs });
      const result = await query(
        `
          WITH ${renderRetentionPreludeCtes({ lockKey: 1, workspaceCutoffs: 5, workspaceIds: 4 })},
          expired AS (
            SELECT a.owner_user_id, a.workspace_id, a.artifact_id
            FROM ${artifactsTable} AS a
            LEFT JOIN retention_overrides AS o ON o.workspace_id = a.workspace_id
            WHERE (SELECT acquired FROM retention_lock)
              AND a.status = 'archived'
              AND COALESCE(a.archived_at, a.updated_at) < $3::timestamptz
              AND COALESCE(a.archived_at, a.updated_at) < COALESCE(o.cutoff, $2::timestamptz)
            ORDER BY COALESCE(a.archived_at, a.updated_at) ASC, a.artifact_id ASC
            LIMIT $6
            FOR UPDATE OF a SKIP LOCKED
          ),
          deleted_artifacts AS (
            DELETE FROM ${artifactsTable} AS a
            USING expired AS x
            WHERE a.owner_user_id = x.owner_user_id
              AND a.workspace_id = x.workspace_id
              AND a.artifact_id = x.artifact_id
            RETURNING 1
          )
          SELECT
            (SELECT acquired FROM retention_lock) AS acquired,
            (SELECT COUNT(*) FROM deleted_artifacts)::int AS deleted
        `,
        [
          buildRetentionLockKey(artifactsTable),
          normalized.cutoff,
          normalized.upperBound,
          normalized.workspaceIds,
          normalized.workspaceCutoffs,
          normalizeRetentionBatchLimit(limit),
        ]
      );
      const row = result.rows?.[0];

      return {
        acquired: readRetentionLockAcquired(row),
        deleted: Number(row?.deleted ?? 0) || 0,
      };
    },
  };
};
