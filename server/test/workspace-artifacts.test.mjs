import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  WORKSPACE_ARTIFACT_LIMITS,
  createDefaultWorkspaceArtifactStore,
  createInMemoryWorkspaceArtifactStore,
  createWorkspaceArtifactService,
  toWorkspaceArtifactDetail,
  toWorkspaceArtifactReference,
  toWorkspaceArtifactSummary,
} from "../rag/workspace-artifacts/index.js";

const ACCESS_SCOPE = Object.freeze({
  userId: "alice",
  workspaceId: "workspace-a",
});

test("workspace artifact service creates a scoped artifact with a sanitized contract", async () => {
  const service = createWorkspaceArtifactService({
    createArtifactId: () => "artifact-1",
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });

  const artifact = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact: {
      artifactType: ARTIFACT_TYPES.report,
      citationManifest: [
        {
          docId: "doc-1",
          excerpt: "Supported excerpt",
          pageNumber: 4,
          prompt: "do not persist",
          title: "Source one",
        },
      ],
      content: "# Stored report",
      docIds: ["doc-1", "doc-1", ""],
      fileName: "stored-report.md",
      format: "markdown",
      idempotencyKey: "deliverable:task-1:report",
      mimeType: "text/markdown",
      payload: {
        approvalPayload: {
          approved: true,
          decision: "do not persist",
        },
        apiKey: "private API key",
        sections: ["Findings"],
        authorizationHeader: "Bearer secret",
        cookie: "session=do-not-persist",
        credentials: "private credentials",
        nested: {
          password: "private password",
          rawTrace: "private trace",
          secret: "private secret",
          strategy: "grounded",
        },
      },
      prompt: "private prompt",
      sourceRunId: "run-1",
      sourceTaskId: "task-1",
      title: "Stored report",
      token: "private token",
    },
  });

  assert.deepEqual(artifact, {
    archivedAt: null,
    artifactId: "artifact-1",
    artifactType: ARTIFACT_TYPES.report,
    citationManifest: [
      {
        docId: "doc-1",
        excerpt: "Supported excerpt",
        pageNumber: 4,
        title: "Source one",
      },
    ],
    content: "# Stored report",
    createdAt: "2026-07-15T00:00:00.000Z",
    docIds: ["doc-1"],
    fileName: "stored-report.md",
    format: "markdown",
    idempotencyKey: "deliverable:task-1:report",
    mimeType: "text/markdown",
    ownerUserId: "alice",
    payload: {
      nested: {
        strategy: "grounded",
      },
      sections: ["Findings"],
    },
    sourceRunId: "run-1",
    sourceTaskId: "task-1",
    status: ARTIFACT_STATUSES.active,
    title: "Stored report",
    updatedAt: "2026-07-15T00:00:00.000Z",
    version: "1.0.0",
    workspaceId: "workspace-a",
  });

  assert.deepEqual(
    await service.getArtifact({
      accessScope: ACCESS_SCOPE,
      artifactId: artifact.artifactId,
    }),
    artifact
  );
});

test("workspace artifact service owns artifact ids and rejects colliding scope prefixes", async () => {
  let artifactId = 0;
  const service = createWorkspaceArtifactService({
    createArtifactId: () => `generated-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const buildArtifact = (idempotencyKey) => ({
    artifactId: "caller-controlled-id",
    artifactType: ARTIFACT_TYPES.summary,
    content: "Scoped summary",
    fileName: "summary.md",
    format: "markdown",
    idempotencyKey,
    mimeType: "text/markdown",
    title: "Scoped summary",
  });
  const first = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact: buildArtifact("first"),
  });
  const second = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact: buildArtifact("second"),
  });

  assert.equal(first.artifactId, "generated-1");
  assert.equal(second.artifactId, "generated-2");

  await assert.rejects(
    () =>
      service.createArtifact({
        accessScope: {
          userId: `${"x".repeat(180)}A`,
          workspaceId: "workspace-a",
        },
        artifact: buildArtifact("scope-overflow"),
      }),
    (error) =>
      error.code === "invalid_workspace_artifact" &&
      /userId/.test(error.message)
  );
});

test("workspace artifact create is idempotent within an access scope", async () => {
  const artifactIds = ["artifact-1", "artifact-2"];
  const service = createWorkspaceArtifactService({
    createArtifactId: () => artifactIds.shift(),
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const request = {
    accessScope: ACCESS_SCOPE,
    artifact: {
      artifactType: ARTIFACT_TYPES.summary,
      content: "Original summary",
      fileName: "summary.md",
      format: "markdown",
      idempotencyKey: "deliverable:task-1:summary",
      mimeType: "text/markdown",
      title: "Summary",
    },
  };

  const first = await service.createArtifact(request);
  const replay = await service.createArtifact({
    ...request,
    artifact: {
      ...request.artifact,
      content: "Replay must not overwrite the first artifact",
    },
  });

  assert.equal(first.artifactId, "artifact-1");
  assert.deepEqual(replay, first);
});

test("workspace artifact reads and lists stay isolated by access scope", async () => {
  let artifactId = 0;
  const service = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const artifact = {
    artifactType: ARTIFACT_TYPES.summary,
    content: "Scoped summary",
    fileName: "summary.md",
    format: "markdown",
    idempotencyKey: "same-key-in-different-scopes",
    mimeType: "text/markdown",
    title: "Scoped summary",
  };
  const aliceArtifact = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact,
  });
  const bobScope = {
    userId: "bob",
    workspaceId: "workspace-a",
  };
  const bobArtifact = await service.createArtifact({
    accessScope: bobScope,
    artifact,
  });

  assert.notEqual(aliceArtifact.artifactId, bobArtifact.artifactId);
  assert.equal(
    await service.getArtifact({
      accessScope: ACCESS_SCOPE,
      artifactId: bobArtifact.artifactId,
    }),
    null
  );
  assert.deepEqual(await service.listArtifacts({ accessScope: ACCESS_SCOPE }), {
    artifacts: [aliceArtifact],
    limit: 50,
    offset: 0,
    total: 1,
  });
});

test("workspace artifact service archives and filters paginated results", async () => {
  let artifactId = 0;
  let timestamp = 0;
  const service = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => `2026-07-15T00:00:0${(timestamp += 1)}.000Z`,
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const createArtifact = ({ artifactType, idempotencyKey, title }) =>
    service.createArtifact({
      accessScope: ACCESS_SCOPE,
      artifact: {
        artifactType,
        content: title,
        fileName: `${idempotencyKey}.md`,
        format: "markdown",
        idempotencyKey,
        mimeType: "text/markdown",
        title,
      },
    });

  const report = await createArtifact({
    artifactType: ARTIFACT_TYPES.report,
    idempotencyKey: "report-1",
    title: "Report",
  });
  await createArtifact({
    artifactType: ARTIFACT_TYPES.summary,
    idempotencyKey: "summary-1",
    title: "Summary one",
  });
  const latestSummary = await createArtifact({
    artifactType: ARTIFACT_TYPES.summary,
    idempotencyKey: "summary-2",
    title: "Summary two",
  });
  const archived = await service.archiveArtifact({
    accessScope: ACCESS_SCOPE,
    artifactId: report.artifactId,
  });

  assert.equal(archived.status, ARTIFACT_STATUSES.archived);
  assert.equal(archived.archivedAt, "2026-07-15T00:00:04.000Z");
  assert.equal(archived.updatedAt, archived.archivedAt);
  assert.deepEqual(
    await service.listArtifacts({
      accessScope: ACCESS_SCOPE,
      artifactType: ARTIFACT_TYPES.summary,
      limit: 1,
      offset: 0,
    }),
    {
      artifacts: [latestSummary],
      limit: 1,
      offset: 0,
      total: 2,
    }
  );
  assert.deepEqual(
    await service.listArtifacts({
      accessScope: ACCESS_SCOPE,
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

test("workspace artifact store auto provider follows PostgreSQL configuration", async () => {
  let migrationRuns = 0;
  const memoryStore = createDefaultWorkspaceArtifactStore({
    postgresConfigured: false,
    provider: "auto",
  });
  const postgresStore = createDefaultWorkspaceArtifactStore({
    postgres: {
      query: async () => ({ rows: [] }),
      runMigrations: async () => {
        migrationRuns += 1;
        return {
          appliedMigrations: [],
          status: "ok",
        };
      },
      tableName: "rag_workspace_artifacts_test",
    },
    postgresConfigured: true,
    provider: "auto",
  });

  assert.equal(await memoryStore.initialize(), true);
  assert.equal(migrationRuns, 0);
  assert.equal(await postgresStore.initialize(), true);
  assert.equal(migrationRuns, 1);
});

test("workspace artifact public projections expose only their intended surface", async () => {
  const service = createWorkspaceArtifactService({
    createArtifactId: () => "artifact-1",
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const artifact = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact: {
      artifactType: ARTIFACT_TYPES.report,
      citationManifest: [{ docId: "doc-1", title: "Source" }],
      content: "Private full report body",
      docIds: ["doc-1"],
      fileName: "report.md",
      format: "markdown",
      idempotencyKey: "private-idempotency-key",
      mimeType: "text/markdown",
      payload: { sectionCount: 1 },
      sourceRunId: "run-1",
      sourceTaskId: "task-1",
      title: "Report",
    },
  });

  assert.deepEqual(toWorkspaceArtifactReference(artifact), {
    artifactId: "artifact-1",
    artifactType: ARTIFACT_TYPES.report,
    fileName: "report.md",
    format: "markdown",
    mimeType: "text/markdown",
    sourceRunId: "run-1",
    sourceTaskId: "task-1",
    status: ARTIFACT_STATUSES.active,
    title: "Report",
  });
  assert.deepEqual(toWorkspaceArtifactSummary(artifact), {
    ...toWorkspaceArtifactReference(artifact),
    citationCount: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    docCount: 1,
    updatedAt: "2026-07-15T00:00:00.000Z",
  });

  const detail = toWorkspaceArtifactDetail(artifact);

  assert.equal(detail.content, "Private full report body");
  assert.deepEqual(detail.payload, { sectionCount: 1 });
  assert.equal(detail.idempotencyKey, undefined);
  assert.equal(detail.ownerUserId, undefined);
  assert.equal(detail.workspaceId, undefined);
});

test("workspace artifact downloads preserve report content and serialize collections", async () => {
  let artifactId = 0;
  const service = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const report = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact: {
      artifactType: ARTIFACT_TYPES.report,
      content: "# Downloaded report",
      fileName: "downloaded-report.md",
      format: "markdown",
      idempotencyKey: "download-report",
      mimeType: "text/markdown",
      title: "Downloaded report",
    },
  });
  const collection = await service.createArtifact({
    accessScope: ACCESS_SCOPE,
    artifact: {
      artifactType: ARTIFACT_TYPES.documentCollection,
      docIds: ["doc-1", "doc-2"],
      fileName: "policy-collection.json",
      format: "json",
      idempotencyKey: "download-collection",
      mimeType: "application/json",
      payload: {
        groups: [
          {
            docIds: ["doc-1", "doc-2"],
            label: "policy",
          },
        ],
      },
      title: "Policy collection",
    },
  });

  const reportDownload = await service.getArtifactDownload({
    accessScope: ACCESS_SCOPE,
    artifactId: report.artifactId,
  });
  const collectionDownload = await service.getArtifactDownload({
    accessScope: ACCESS_SCOPE,
    artifactId: collection.artifactId,
  });

  assert.equal(reportDownload.fileName, "downloaded-report.md");
  assert.equal(reportDownload.mimeType, "text/markdown");
  assert.equal(reportDownload.fileBuffer.toString("utf8"), "# Downloaded report");
  assert.equal(collectionDownload.fileName, "policy-collection.json");
  assert.equal(collectionDownload.mimeType, "application/json");
  assert.deepEqual(JSON.parse(collectionDownload.fileBuffer.toString("utf8")), {
    artifactId: collection.artifactId,
    artifactType: ARTIFACT_TYPES.documentCollection,
    citationManifest: [],
    docIds: ["doc-1", "doc-2"],
    payload: {
      groups: [
        {
          docIds: ["doc-1", "doc-2"],
          label: "policy",
        },
      ],
    },
    title: "Policy collection",
    version: "1.0.0",
  });
  assert.equal(
    await service.getArtifactDownload({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
      artifactId: report.artifactId,
    }),
    null
  );
});

test("workspace artifact service rejects unsupported list filters", async () => {
  const service = createWorkspaceArtifactService();

  await assert.rejects(
    () =>
      service.listArtifacts({
        accessScope: ACCESS_SCOPE,
        artifactType: "prompt_dump",
      }),
    (error) =>
      error.status === 400 &&
      error.code === "invalid_workspace_artifact" &&
      /artifactType/.test(error.message)
  );
  await assert.rejects(
    () =>
      service.listArtifacts({
        accessScope: ACCESS_SCOPE,
        status: "deleted",
      }),
    (error) =>
      error.status === 400 &&
      error.code === "invalid_workspace_artifact" &&
      /status/.test(error.message)
  );
  await assert.rejects(
    () =>
      service.listArtifacts({
        accessScope: ACCESS_SCOPE,
        offset: Number.POSITIVE_INFINITY,
      }),
    (error) =>
      error.status === 400 &&
      error.code === "invalid_workspace_artifact" &&
      /offset/.test(error.message)
  );
});

test("workspace artifact service rejects oversized document and citation collections", async () => {
  const service = createWorkspaceArtifactService({
    createArtifactId: () => "artifact-limit",
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const baseArtifact = {
    artifactType: ARTIFACT_TYPES.report,
    content: "Report",
    fileName: "report.md",
    format: "markdown",
    mimeType: "text/markdown",
    title: "Report",
  };

  await assert.rejects(
    () =>
      service.createArtifact({
        accessScope: ACCESS_SCOPE,
        artifact: {
          ...baseArtifact,
          docIds: Array.from(
            { length: WORKSPACE_ARTIFACT_LIMITS.docIdCount + 1 },
            (_, index) => `doc-${index}`
          ),
          idempotencyKey: "too-many-documents",
        },
      }),
    /docIds exceeds/
  );
  await assert.rejects(
    () =>
      service.createArtifact({
        accessScope: ACCESS_SCOPE,
        artifact: {
          ...baseArtifact,
          citationManifest: Array.from(
            { length: WORKSPACE_ARTIFACT_LIMITS.citationCount + 1 },
            (_, index) => ({ docId: `doc-${index}` })
          ),
          idempotencyKey: "too-many-citations",
        },
      }),
    /citationManifest exceeds/
  );
});
