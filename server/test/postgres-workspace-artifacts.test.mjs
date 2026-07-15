import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  createPostgresWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "../rag/workspace-artifacts/index.js";

const parseJson = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  return typeof value === "string" ? JSON.parse(value) : value;
};

const buildFakeArtifactRow = (values) => ({
  archived_at: values[19] || null,
  artifact_id: values[2],
  artifact_type: values[3],
  citation_manifest: parseJson(values[13], []),
  content: values[10],
  created_at: values[17],
  doc_ids: parseJson(values[12], []),
  file_name: values[9],
  format: values[7],
  idempotency_key: values[16],
  mime_type: values[8],
  owner_user_id: values[0],
  payload: parseJson(values[11], {}),
  source_run_id: values[15],
  source_task_id: values[14],
  status: values[6],
  title: values[5],
  updated_at: values[18],
  version: values[4],
  workspace_id: values[1],
});

test("postgres workspace artifact store persists scoped idempotent creates", async () => {
  const rowsById = new Map();
  const idsByIdempotency = new Map();
  let migrationRuns = 0;
  const scopeKey = (userId, workspaceId) => `${userId}\u0000${workspaceId}`;
  const artifactKey = (userId, workspaceId, artifactId) =>
    `${scopeKey(userId, workspaceId)}\u0000${artifactId}`;
  const idempotencyKey = (userId, workspaceId, key) =>
    `${scopeKey(userId, workspaceId)}\u0000${key}`;
  const query = async (queryText, values = []) => {
    if (queryText.includes("INSERT INTO rag_workspace_artifacts_test")) {
      const conflictKey = idempotencyKey(values[0], values[1], values[16]);

      if (idsByIdempotency.has(conflictKey)) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const row = buildFakeArtifactRow(values);
      const key = artifactKey(values[0], values[1], values[2]);

      rowsById.set(key, row);
      idsByIdempotency.set(conflictKey, key);

      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("idempotency_key = $3") &&
      queryText.includes("FROM rag_workspace_artifacts_test")
    ) {
      const key = idsByIdempotency.get(
        idempotencyKey(values[0], values[1], values[2])
      );
      const row = key ? rowsById.get(key) : null;

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      };
    }

    if (
      queryText.includes("artifact_id = $3") &&
      queryText.includes("FROM rag_workspace_artifacts_test")
    ) {
      const row = rowsById.get(artifactKey(values[0], values[1], values[2]));

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };
  const service = createWorkspaceArtifactService({
    createArtifactId: (() => {
      let artifactId = 0;
      return () => `artifact-${(artifactId += 1)}`;
    })(),
    now: () => "2026-07-15T00:00:00.000Z",
    store: createPostgresWorkspaceArtifactStore({
      query,
      runMigrations: async () => {
        migrationRuns += 1;
        return {
          appliedMigrations: [],
          status: "ok",
        };
      },
      tableName: "rag_workspace_artifacts_test",
    }),
  });
  const accessScope = {
    userId: "  alice   team  ",
    workspaceId: " workspace   a ",
  };
  const request = {
    accessScope,
    artifact: {
      artifactType: ARTIFACT_TYPES.report,
      content: "Persisted report",
      fileName: "report.md",
      format: "markdown",
      idempotencyKey: "deliverable:task-1:report",
      mimeType: "text/markdown",
      sourceTaskId: "task-1",
      title: "Persisted report",
    },
  };

  await service.initialize();
  await service.initialize();
  const created = await service.createArtifact(request);
  const replay = await service.createArtifact({
    ...request,
    artifact: {
      ...request.artifact,
      content: "Replay must not overwrite",
    },
  });

  assert.equal(migrationRuns, 1);
  assert.equal(created.ownerUserId, "alice team");
  assert.equal(created.workspaceId, "workspace a");
  assert.deepEqual(replay, created);
  assert.deepEqual(
    await service.getArtifact({
      accessScope,
      artifactId: created.artifactId,
    }),
    created
  );
  assert.equal(
    await service.getArtifact({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
      artifactId: created.artifactId,
    }),
    null
  );
});

test("postgres workspace artifact store lists and archives scoped artifacts", async () => {
  const row = buildFakeArtifactRow([
    "alice",
    "workspace-a",
    "artifact-1",
    ARTIFACT_TYPES.report,
    "1.0.0",
    "Persisted report",
    ARTIFACT_STATUSES.active,
    "markdown",
    "text/markdown",
    "report.md",
    "Persisted report",
    JSON.stringify({}),
    JSON.stringify(["doc-1"]),
    JSON.stringify([{ docId: "doc-1", title: "Source" }]),
    "task-1",
    "run-1",
    "deliverable:task-1:report",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    null,
  ]);
  const query = async (queryText, values = []) => {
    if (queryText.includes("COUNT(*) AS total")) {
      const matches =
        row.owner_user_id === values[0] &&
        row.workspace_id === values[1] &&
        (!values[2] || row.artifact_type === values[2]) &&
        (!values[3] || row.status === values[3]);

      return {
        rows: [{ total: matches ? "1" : "0" }],
      };
    }

    if (
      queryText.includes("FROM rag_workspace_artifacts_test") &&
      queryText.includes("LIMIT $5 OFFSET $6")
    ) {
      const matches =
        row.owner_user_id === values[0] &&
        row.workspace_id === values[1] &&
        (!values[2] || row.artifact_type === values[2]) &&
        (!values[3] || row.status === values[3]);

      return {
        rows: matches ? [row] : [],
      };
    }

    if (queryText.includes("UPDATE rag_workspace_artifacts_test")) {
      const matches =
        row.owner_user_id === values[0] &&
        row.workspace_id === values[1] &&
        row.artifact_id === values[2];

      if (!matches) {
        return {
          rows: [],
        };
      }

      if (!row.archived_at) {
        row.archived_at = values[3];
        row.updated_at = values[3];
      }
      row.status = ARTIFACT_STATUSES.archived;

      return {
        rows: [row],
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };
  let timestamp = 0;
  const service = createWorkspaceArtifactService({
    now: () => `2026-07-15T00:00:0${(timestamp += 1)}.000Z`,
    store: createPostgresWorkspaceArtifactStore({
      query,
      runMigrations: async () => ({
        appliedMigrations: [],
        status: "ok",
      }),
      tableName: "rag_workspace_artifacts_test",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const activeList = await service.listArtifacts({
    accessScope,
    artifactType: ARTIFACT_TYPES.report,
  });

  assert.equal(activeList.total, 1);
  assert.equal(activeList.artifacts[0].artifactId, "artifact-1");

  const archived = await service.archiveArtifact({
    accessScope,
    artifactId: "artifact-1",
  });
  const replay = await service.archiveArtifact({
    accessScope,
    artifactId: "artifact-1",
  });

  assert.equal(archived.status, ARTIFACT_STATUSES.archived);
  assert.equal(archived.archivedAt, "2026-07-15T00:00:01.000Z");
  assert.deepEqual(replay, archived);
  assert.deepEqual(
    await service.listArtifacts({
      accessScope,
      status: ARTIFACT_STATUSES.archived,
    }),
    {
      artifacts: [archived],
      limit: 50,
      offset: 0,
      total: 1,
    }
  );
});
