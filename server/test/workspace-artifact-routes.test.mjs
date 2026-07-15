import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import {
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  createInMemoryWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "../rag/workspace-artifacts/index.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";

const ACCESS_SCOPE = Object.freeze({
  userId: "alice",
  workspaceId: "workspace-a",
});

const okHealthService = {
  buildHealthReport: async () => ({
    checks: {},
    status: "ok",
  }),
  runStartupHealthChecks: async () => ({
    checks: {},
    status: "ok",
  }),
};

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const createTestApp = async ({ tempRoot, ...options } = {}) =>
  createApp({
    agentRunStore: createInMemoryAgentRunStore(),
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    taskStore: createInMemoryTaskStore(),
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    ...options,
  });

test("workspace artifact routes are scoped, projected, downloadable, and archivable", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workspace-artifact-routes-"));
  let artifactId = 0;
  let timestamp = 0;
  const workspaceArtifactService = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => `2026-07-15T00:00:0${(timestamp += 1)}.000Z`,
    store: createInMemoryWorkspaceArtifactStore(),
  });

  try {
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_AUTH_TOKEN = "";
    process.env.API_AUTH_TOKENS = JSON.stringify({
      "intruder-token": {
        userId: "bob",
        workspaceId: "workspace-b",
      },
      "owner-token": ACCESS_SCOPE,
    });

    const report = await workspaceArtifactService.createArtifact({
      accessScope: ACCESS_SCOPE,
      artifact: {
        artifactType: ARTIFACT_TYPES.report,
        citationManifest: [{ docId: "doc-1", title: "Policy" }],
        content: "# Scoped report",
        docIds: ["doc-1"],
        fileName: "scoped-report.md",
        format: "markdown",
        idempotencyKey: "route-report",
        mimeType: "text/markdown",
        payload: { sectionCount: 1 },
        title: "Scoped report",
      },
    });
    const summary = await workspaceArtifactService.createArtifact({
      accessScope: ACCESS_SCOPE,
      artifact: {
        artifactType: ARTIFACT_TYPES.summary,
        content: "Scoped summary",
        fileName: "scoped-summary.md",
        format: "markdown",
        idempotencyKey: "route-summary",
        mimeType: "text/markdown",
        title: "Scoped summary",
      },
    });
    const collection = await workspaceArtifactService.createArtifact({
      accessScope: ACCESS_SCOPE,
      artifact: {
        artifactType: ARTIFACT_TYPES.documentCollection,
        docIds: ["doc-1", "doc-2"],
        fileName: "policy-collection.json",
        format: "json",
        idempotencyKey: "route-collection",
        mimeType: "application/json",
        payload: {
          groups: [{ docIds: ["doc-1", "doc-2"], label: "policy" }],
        },
        title: "Policy collection",
      },
    });
    const app = await createTestApp({
      tempRoot,
      workspaceArtifactService,
    });
    const server = await startServer(app);
    const ownerHeaders = {
      "x-api-key": "owner-token",
    };

    try {
      let response = await fetch(`${server.baseUrl}/artifacts`);
      assert.equal(response.status, 401);

      response = await fetch(`${server.baseUrl}/artifacts`, {
        headers: ownerHeaders,
      });
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.total, 3);
      assert.equal(body.limit, 50);
      assert.equal(body.offset, 0);
      assert.deepEqual(
        body.artifacts.map((artifact) => artifact.artifactId),
        [collection.artifactId, summary.artifactId, report.artifactId]
      );
      assert.equal(body.artifacts[0].content, undefined);
      assert.equal(body.artifacts[0].payload, undefined);
      assert.equal(body.artifacts[0].idempotencyKey, undefined);
      assert.equal(body.artifacts[0].ownerUserId, undefined);
      assert.equal(body.artifacts[0].workspaceId, undefined);

      response = await fetch(
        `${server.baseUrl}/artifacts?artifactType=report&limit=1&offset=0`,
        { headers: ownerHeaders }
      );
      body = await response.json();
      assert.equal(body.total, 1);
      assert.deepEqual(body.artifacts.map((artifact) => artifact.artifactId), [
        report.artifactId,
      ]);

      response = await fetch(
        `${server.baseUrl}/artifacts/${report.artifactId}`,
        { headers: ownerHeaders }
      );
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.artifact.content, "# Scoped report");
      assert.deepEqual(body.artifact.payload, { sectionCount: 1 });
      assert.equal(body.artifact.idempotencyKey, undefined);

      response = await fetch(
        `${server.baseUrl}/artifacts/${report.artifactId}/download`,
        {
          headers: {
            ...ownerHeaders,
            Origin: "https://workspace.example.test",
          },
        }
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/markdown");
      assert.match(
        response.headers.get("content-disposition") ?? "",
        /^attachment;/
      );
      assert.match(
        response.headers.get("access-control-expose-headers") ?? "",
        /content-disposition/i
      );
      assert.equal(await response.text(), "# Scoped report");

      response = await fetch(
        `${server.baseUrl}/artifacts/${collection.artifactId}/download`,
        { headers: ownerHeaders }
      );
      assert.equal(response.status, 200);
      body = await response.json();
      assert.deepEqual(body.docIds, ["doc-1", "doc-2"]);
      assert.deepEqual(body.payload.groups[0].docIds, ["doc-1", "doc-2"]);

      for (const suffix of [
        `${report.artifactId}`,
        `${report.artifactId}/download`,
      ]) {
        response = await fetch(`${server.baseUrl}/artifacts/${suffix}`, {
          headers: {
            "x-api-key": "intruder-token",
          },
        });
        assert.equal(response.status, 404);
        assert.equal((await response.json()).error, "Workspace artifact not found.");
      }

      response = await fetch(
        `${server.baseUrl}/artifacts/${report.artifactId}/archive`,
        {
          headers: {
            "x-api-key": "intruder-token",
          },
          method: "POST",
        }
      );
      assert.equal(response.status, 404);

      response = await fetch(
        `${server.baseUrl}/artifacts/${summary.artifactId}/archive`,
        {
          headers: ownerHeaders,
          method: "POST",
        }
      );
      assert.equal(response.status, 200);
      const firstArchive = (await response.json()).artifact;
      assert.equal(firstArchive.status, ARTIFACT_STATUSES.archived);

      response = await fetch(
        `${server.baseUrl}/artifacts/${summary.artifactId}/archive`,
        {
          headers: ownerHeaders,
          method: "POST",
        }
      );
      assert.equal(response.status, 200);
      const replayedArchive = (await response.json()).artifact;
      assert.equal(replayedArchive.archivedAt, firstArchive.archivedAt);

      response = await fetch(`${server.baseUrl}/artifacts`, {
        headers: ownerHeaders,
      });
      body = await response.json();
      assert.equal(body.total, 2);

      response = await fetch(
        `${server.baseUrl}/artifacts?status=archived`,
        { headers: ownerHeaders }
      );
      body = await response.json();
      assert.equal(body.total, 1);
      assert.equal(body.artifacts[0].artifactId, summary.artifactId);

      response = await fetch(
        `${server.baseUrl}/artifacts?artifactType=prompt_dump`,
        { headers: ownerHeaders }
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "invalid_workspace_artifact");
    } finally {
      await server.close();
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true });

    if (originalAuthEnabled === undefined) {
      delete process.env.API_AUTH_ENABLED;
    } else {
      process.env.API_AUTH_ENABLED = originalAuthEnabled;
    }

    if (originalAuthToken === undefined) {
      delete process.env.API_AUTH_TOKEN;
    } else {
      process.env.API_AUTH_TOKEN = originalAuthToken;
    }

    if (originalAuthTokens === undefined) {
      delete process.env.API_AUTH_TOKENS;
    } else {
      process.env.API_AUTH_TOKENS = originalAuthTokens;
    }
  }
});

test("workspace artifact storage initializes before recovery", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workspace-artifact-init-"));
  const events = [];

  try {
    await createTestApp({
      agentRunRecoveryService: {
        recoverOnStartup: async () => {
          events.push("run-recovery");
        },
      },
      healthService: {
        ...okHealthService,
        runStartupHealthChecks: async () => {
          events.push("health");
        },
      },
      jobOrchestrator: {
        recoverRunnableTasks: async () => {
          events.push("task-recovery");
        },
      },
      tempRoot,
      workspaceArtifactService: {
        archiveArtifact: async () => null,
        createArtifact: async () => null,
        getArtifact: async () => null,
        getArtifactDownload: async () => null,
        initialize: async () => {
          events.push("artifact-init");
        },
        listArtifacts: async () => ({
          artifacts: [],
          limit: 50,
          offset: 0,
          total: 0,
        }),
      },
    });

    assert.deepEqual(events, [
      "artifact-init",
      "run-recovery",
      "task-recovery",
      "health",
    ]);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});
