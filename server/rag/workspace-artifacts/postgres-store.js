import { getWorkspaceArtifactsPostgresTable } from "../config.js";
import { runPostgresMigrations } from "../db-migrations.js";
import { queryPostgres } from "../postgres.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureTableName = (tableName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `WORKSPACE_ARTIFACTS_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const normalizeText = (value) => String(value ?? "").trim();

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
  archived_at
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
  };
};
