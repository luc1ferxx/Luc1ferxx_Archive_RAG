// The document trash (DOCUMENT_TRASH_RETENTION_HOURS, migration 042,
// rag/document-trash.js) without a database: the setting, the start-up
// refusal where the trash cannot work, the routes and their audit events over
// a stand-in ragService, the purge service (cascade and audit per deleting
// scope, in that scope's database context), the retention sweep's hours-based
// type that no workspace policy blocks, and the route tables. The SQL and the
// whole path on PostgreSQL are document-trash-postgres.integration.test.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { createFileFeedbackStore } from "../feedback.js";
import {
  ADMIN_AUDIT_EVENT_TYPES,
  createAdminAuditService,
  createInMemoryAdminAuditStore,
  DATA_ACCESS_ACTION_IDS,
} from "../rag/admin-audit.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import {
  getDocumentTrashRetentionHours,
  isDocumentTrashEnabled,
  MAX_DOCUMENT_TRASH_RETENTION_HOURS,
} from "../rag/config.js";
import {
  configureDocumentRegistryStore,
  listTrashedDocuments,
  resetDocumentRegistryStore,
  supportsDocumentRegistryTrash,
} from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import { createDocumentDeletionCascade } from "../rag/document-deletion-cascade.js";
import {
  assertDocumentTrashSupported,
  computeTrashPurgeAfter,
  createDocumentTrashService,
  describeTrashedDocument,
  DOCUMENT_TRASH_ERROR_CODES,
} from "../rag/document-trash.js";
import { deleteDocument, ingestDocument, restoreDocument, supportsDocumentTrash } from "../rag/index.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { getActiveDatabaseTenant, getDatabaseTenantContext } from "../rag/postgres-tenant.js";
import { matchRbacRoute, RBAC_PERMISSION_IDS } from "../rag/rbac.js";
import {
  createRetentionSweeper,
  RETENTION_DATA_TYPES,
  resolveRetentionTargets,
} from "../rag/retention.js";
import { computeRetentionCutoffHours } from "../rag/retention-sql.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import { classifyTenantLimitRequest, TENANT_LIMIT_CLASSES } from "../rag/tenant-limits.js";
import { resetVectorStore } from "../rag/vector-store.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const HOUR_MS = 60 * 60 * 1000;
const ENV_KEYS = [
  "ADMIN_AUDIT_DATA_EVENTS",
  "AGENT_SERVICE_URL",
  "API_AUTH_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "ARCHIVE_RAG_ROLE",
  "DOCUMENT_DELETE_REDACTION",
  "DOCUMENT_TRASH_RETENTION_HOURS",
  "FEEDBACK_RETENTION_DAYS",
  "RAG_INGEST_MODE",
  "RATE_LIMIT_ENABLED",
  "RBAC_MODE",
];
const TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
};
const silentLogger = { error() {}, log() {}, warn() {} };

const applyEnv = (values) => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  return () => {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};

const withEnv = async (values, run) => {
  const restore = applyEnv(values);

  try {
    return await run();
  } finally {
    restore();
  }
};

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const buildApp = (tempRoot, options = {}) =>
  createProductionApp({
    adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore({ maxEvents: 1000 }) }),
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    feedbackStore: createFileFeedbackStore(),
    healthService: okHealthService,
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    taskStore: createInMemoryTaskStore(),
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    ...options,
  });

const startServer = async (app) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const call = async (server, method, requestPath) => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, {
    headers: { "x-api-key": "alice-token" },
    method,
  });
  const text = await response.text();

  return { json: text ? JSON.parse(text) : null, status: response.status };
};

describe("the setting", () => {
  test("DOCUMENT_TRASH_RETENTION_HOURS: 0 by default, whole hours, capped", async () => {
    await withEnv({}, () => {
      assert.equal(getDocumentTrashRetentionHours(), 0);
      assert.equal(isDocumentTrashEnabled(), false);
    });

    for (const [value, expected] of [
      ["24", 24],
      ["1.9", 1],
      ["", 0],
      ["  ", 0],
      ["-3", 0],
      ["soon", 0],
      ["999999999", MAX_DOCUMENT_TRASH_RETENTION_HOURS],
    ]) {
      await withEnv({ DOCUMENT_TRASH_RETENTION_HOURS: value }, () => {
        assert.equal(getDocumentTrashRetentionHours(), expected, JSON.stringify(value));
      });
    }
  });

  test("the purge time is the deletion plus the window, or null with the trash off", () => {
    assert.equal(
      computeTrashPurgeAfter("2026-10-01T00:00:00.000Z", 36),
      "2026-10-02T12:00:00.000Z"
    );
    assert.equal(computeTrashPurgeAfter("2026-10-01T00:00:00.000Z", 0), null);
    assert.equal(computeTrashPurgeAfter("not a time", 24), null);
    assert.deepEqual(describeTrashedDocument({ deletedAt: "2026-10-01T00:00:00.000Z", docId: "d" }, { hours: 1 }), {
      deletedAt: "2026-10-01T00:00:00.000Z",
      docId: "d",
      purgeAfter: "2026-10-01T01:00:00.000Z",
    });
    assert.equal(computeRetentionCutoffHours({ hours: 2, now: Date.parse("2026-10-01T05:00:00Z") }), "2026-10-01T03:00:00.000Z");
    assert.equal(computeRetentionCutoffHours({ hours: 0, now: Date.now() }), null);
  });
});

describe("where the trash cannot work", () => {
  const state = {};

  before(async () => {
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "document-trash-unit-"));
    state.originalRagDataDirectory = getRagDataDirectory();
    configureRagDataDirectory(path.join(state.tempRoot, "rag-data"));
    await resetDocumentRegistryStore();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    resetVectorStore();
    configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async () => [1, 0, 0],
      embedTexts: async (texts) => texts.map(() => [1, 0, 0]),
    });
  });

  after(async () => {
    resetVectorStore();
    await resetDocumentRegistryStore();
    resetOpenAIProvider();
    configureRagDataDirectory(state.originalRagDataDirectory);
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  test("the local index with the file registry keeps no trash, and the start is refused", async () => {
    assert.equal(supportsDocumentRegistryTrash(), false);
    assert.equal(supportsDocumentTrash(), false);
    assert.deepEqual(await listTrashedDocuments({ userId: "alice" }), []);

    assert.doesNotThrow(() => assertDocumentTrashSupported({ hours: 0 }));
    assert.throws(() => assertDocumentTrashSupported({ hours: 24 }), (error) => {
      assert.equal(error.code, DOCUMENT_TRASH_ERROR_CODES.unsupported);
      assert.match(error.message, /VECTOR_STORE_PROVIDER=pgvector/);
      return true;
    });
    assert.doesNotThrow(() =>
      assertDocumentTrashSupported({ hours: 24, ragService: { supportsDocumentTrash: () => true } })
    );

    await withEnv({ DOCUMENT_TRASH_RETENTION_HOURS: "24" }, async () => {
      await assert.rejects(() => buildApp(state.tempRoot), (error) => {
        assert.equal(error.code, DOCUMENT_TRASH_ERROR_CODES.unsupported);
        return true;
      });
    });
  });

  test("a delete with the trash on refuses rather than deleting, and a restore finds nothing", async () => {
    const filePath = path.join(state.tempRoot, "alpha.pdf");

    await writeFile(filePath, buildTextPdf({ pages: [["The alpha policy needs approval."]] }));
    await ingestDocument({ docId: "doc-local", fileName: "alpha.pdf", filePath, ownerUserId: "alice" });

    await assert.rejects(
      () => deleteDocument("doc-local", { accessScope: { userId: "alice" }, trash: true }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, DOCUMENT_TRASH_ERROR_CODES.unsupported);
        return true;
      }
    );
    assert.equal(await deleteDocument("doc-missing", { accessScope: { userId: "alice" }, trash: true }), null);
    assert.equal(await restoreDocument({ accessScope: { userId: "alice" }, docId: "doc-local" }), null);
    // Still there, and a delete with the trash off is the immediate one.
    assert.equal((await deleteDocument("doc-local", { accessScope: { userId: "alice" } }))?.docId, "doc-local");
  });
});

describe("the routes over a stand-in ragService", () => {
  const state = {};
  const trashedDocument = {
    deletedAt: "2026-10-01T00:00:00.000Z",
    deletedByUserId: "alice",
    deletedByWorkspaceId: "ws-a",
    docId: "doc-1",
    fileName: "alpha.pdf",
    version: 1,
  };
  const restoreError = (status, extra = {}) =>
    Object.assign(new Error(`stand-in ${status}`), { status, ...extra });

  before(async () => {
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "document-trash-routes-"));
  });

  after(async () => {
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  const start = async () => {
    state.calls = [];
    state.audit = createAdminAuditService({ store: createInMemoryAdminAuditStore({ maxEvents: 1000 }) });

    const app = await buildApp(state.tempRoot, {
      adminAuditService: state.audit,
      ragService: {
        clearDocuments: async () => {
          state.calls.push("clearDocuments");
          return [trashedDocument];
        },
        deleteDocument: async (docId) => {
          state.calls.push("deleteDocument");
          return docId === "doc-1" ? trashedDocument : null;
        },
        initializeDocumentRegistry: async () => [],
        initializeLongMemory: async () => true,
        initializeSessionMemory: async () => true,
        listDocuments: () => [],
        listTrashedDocuments: async (accessScope) => {
          state.calls.push(["listTrashedDocuments", accessScope.userId, accessScope.workspaceId]);
          return [trashedDocument];
        },
        restoreDocument: async ({ accessScope, docId }) => {
          state.calls.push(["restoreDocument", accessScope.userId, docId]);

          if (docId === "doc-dup") {
            throw restoreError(409, { code: "DOCUMENT_RESTORE_DUPLICATE", duplicateDocId: "doc-other" });
          }

          if (docId === "doc-broken") {
            throw restoreError(500, { code: "INTERNAL_DETAIL" });
          }

          if (docId === "doc-gone") {
            throw restoreError(404, { code: "DOCUMENT_NOT_IN_TRASH" });
          }

          return docId === "doc-1" ? { ...trashedDocument, deletedAt: undefined, version: 2 } : null;
        },
        supportsDocumentTrash: () => true,
      },
    });

    state.server = await startServer(app);
  };

  const dataEvents = async () =>
    (await state.audit.listEvents({ limit: 1000 })).events
      .filter((event) => event.type === ADMIN_AUDIT_EVENT_TYPES.dataAccess)
      .reverse()
      .map((event) => [event.dataAccess.actionId, event.dataAccess.outcome]);

  afterEach(async () => {
    await state.server?.close();
    state.server = null;
  });

  test("with the trash on, DELETE and clear answer `trashed` and are audited as moves into the trash", async () => {
    await withEnv(
      {
        ADMIN_AUDIT_DATA_EVENTS: "on",
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKENS: JSON.stringify(TOKENS),
        DOCUMENT_TRASH_RETENTION_HOURS: "24",
      },
      async () => {
        await start();

        let response = await call(state.server, "DELETE", "/documents/doc-1");

        assert.equal(response.status, 200);
        assert.equal(response.json.deleted, true);
        assert.equal(response.json.trashed, true);
        assert.equal(Date.parse(response.json.purgeAfter) - Date.parse(trashedDocument.deletedAt), 24 * HOUR_MS);

        response = await call(state.server, "DELETE", "/documents/doc-404");
        assert.equal(response.status, 404);

        response = await call(state.server, "POST", "/documents/clear");
        assert.equal(response.status, 200);
        assert.equal(response.json.trashed, true);
        assert.equal(response.json.deletedCount, 1);

        assert.deepEqual(await dataEvents(), [
          [DATA_ACCESS_ACTION_IDS.documentTrash, "requested"],
          [DATA_ACCESS_ACTION_IDS.documentTrash, "succeeded"],
          [DATA_ACCESS_ACTION_IDS.documentTrash, "requested"],
          [DATA_ACCESS_ACTION_IDS.documentTrash, "not_found"],
          [DATA_ACCESS_ACTION_IDS.documentsTrash, "requested"],
          [DATA_ACCESS_ACTION_IDS.documentsTrash, "succeeded"],
        ]);
      }
    );
  });

  test("with the trash off, DELETE is the immediate delete it always was", async () => {
    await withEnv(
      { ADMIN_AUDIT_DATA_EVENTS: "on", API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKENS) },
      async () => {
        await start();

        const response = await call(state.server, "DELETE", "/documents/doc-1");

        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(response.json).sort(), ["deleted", "document"]);
        assert.deepEqual(await dataEvents(), [
          [DATA_ACCESS_ACTION_IDS.documentDelete, "requested"],
          [DATA_ACCESS_ACTION_IDS.documentDelete, "succeeded"],
        ]);
      }
    );
  });

  test("GET /documents/trash lists the caller's trash with the purge time; the restore answers 200, 404 or 409", async () => {
    await withEnv(
      {
        ADMIN_AUDIT_DATA_EVENTS: "on",
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKENS: JSON.stringify(TOKENS),
        DOCUMENT_TRASH_RETENTION_HOURS: "48",
      },
      async () => {
        await start();

        let response = await call(state.server, "GET", "/documents/trash");

        assert.equal(response.status, 200);
        assert.deepEqual(response.json, [{ ...trashedDocument, purgeAfter: "2026-10-03T00:00:00.000Z" }]);
        assert.deepEqual(state.calls[0], ["listTrashedDocuments", "alice", "ws-a"]);

        response = await call(state.server, "POST", "/documents/doc-1/restore");
        assert.equal(response.status, 200);
        assert.equal(response.json.restored, true);
        assert.equal(response.json.document.version, 2);

        for (const docId of ["doc-unknown", "doc-gone"]) {
          response = await call(state.server, "POST", `/documents/${docId}/restore`);
          assert.equal(response.status, 404);
          assert.equal(response.json.error, "Document not found in the trash.");
        }

        response = await call(state.server, "POST", "/documents/doc-dup/restore");
        assert.equal(response.status, 409);
        assert.equal(response.json.code, "DOCUMENT_RESTORE_DUPLICATE");
        assert.equal(response.json.duplicateDocId, "doc-other");

        response = await call(state.server, "POST", "/documents/doc-broken/restore");
        assert.equal(response.status, 500);
        assert.equal(response.json.code, undefined, "a server error's code stays inside");

        assert.deepEqual(await dataEvents(), [
          [DATA_ACCESS_ACTION_IDS.documentRestore, "succeeded"],
          [DATA_ACCESS_ACTION_IDS.documentRestore, "not_found"],
          [DATA_ACCESS_ACTION_IDS.documentRestore, "not_found"],
          [DATA_ACCESS_ACTION_IDS.documentRestore, "refused"],
          [DATA_ACCESS_ACTION_IDS.documentRestore, "failed"],
        ]);
      }
    );
  });

  test("with the trash off the listing has no purge time (nothing purges it)", async () => {
    await withEnv({ API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKENS) }, async () => {
      await start();

      const response = await call(state.server, "GET", "/documents/trash");

      assert.equal(response.status, 200);
      assert.equal(response.json[0].purgeAfter, null);
    });
  });
});

describe("the purge service", () => {
  const purged = [
    { deletedByUserId: "alice", deletedByWorkspaceId: "ws-a", docId: "doc-a1" },
    { deletedByUserId: "bob", deletedByWorkspaceId: "ws-b", docId: "doc-b1" },
    { deletedByUserId: "alice", deletedByWorkspaceId: "ws-a", docId: "doc-a2" },
  ];

  const createStandIns = ({ auditFails = false, dataEvents = true } = {}) => {
    const cascadeCalls = [];
    const auditCalls = [];
    const warnings = [];
    const service = createDocumentTrashService({
      adminAuditService: {
        recordDataAccess: async (input) => {
          auditCalls.push({ ...input, tenant: getActiveDatabaseTenant() });

          if (auditFails) {
            throw Object.assign(new Error("audit store down"), { code: "ECONNRESET" });
          }
        },
      },
      getCascade: () => ({
        afterDocumentsDeleted: async (input) => {
          cascadeCalls.push({ ...input, context: getDatabaseTenantContext(), tenant: getActiveDatabaseTenant() });
          return { ingestJobs: null, redaction: null };
        },
      }),
      isDataEventsEnabled: () => dataEvents,
      logger: { ...silentLogger, warn: (line) => warnings.push(line) },
      purgeBatch: async ({ cutoff, limit }) => ({
        acquired: true,
        deleted: purged.length,
        documents: purged,
        input: { cutoff, limit },
      }),
    });

    return { auditCalls, cascadeCalls, service, warnings };
  };

  test("runs the cascade with redaction and records one purge event per deleting scope, in its context", async () => {
    const { auditCalls, cascadeCalls, service } = createStandIns();
    const result = await service.deleteExpiredTrash({ cutoff: "2026-10-01T00:00:00.000Z", limit: 10 });

    assert.deepEqual(result, { acquired: true, deleted: 3 });
    assert.deepEqual(
      cascadeCalls.map(({ accessScope, docIds, redact, tenant }) => ({ accessScope, docIds, redact, tenant })),
      [
        { accessScope: { userId: "alice", workspaceId: "ws-a" }, docIds: ["doc-a1", "doc-a2"], redact: true, tenant: { userId: "alice", workspaceId: "ws-a" } },
        { accessScope: { userId: "bob", workspaceId: "ws-b" }, docIds: ["doc-b1"], redact: true, tenant: { userId: "bob", workspaceId: "ws-b" } },
      ]
    );
    assert.deepEqual(
      auditCalls.map(({ actionId, count, resourceIds, tenant }) => ({ actionId, count, resourceIds, tenant })),
      [
        { actionId: DATA_ACCESS_ACTION_IDS.documentPurge, count: 2, resourceIds: ["doc-a1", "doc-a2"], tenant: { userId: "alice", workspaceId: "ws-a" } },
        { actionId: DATA_ACCESS_ACTION_IDS.documentPurge, count: 1, resourceIds: ["doc-b1"], tenant: { userId: "bob", workspaceId: "ws-b" } },
      ]
    );
  });

  test("records nothing with ADMIN_AUDIT_DATA_EVENTS off, and an audit failure never fails the purge", async () => {
    const off = createStandIns({ dataEvents: false });

    await off.service.deleteExpiredTrash({ cutoff: "2026-10-01T00:00:00.000Z", limit: 10 });
    assert.deepEqual(off.auditCalls, []);
    assert.equal(off.cascadeCalls.length, 2);

    const failing = createStandIns({ auditFails: true });

    assert.deepEqual(await failing.service.deleteExpiredTrash({ cutoff: "2026-10-01T00:00:00.000Z", limit: 10 }), {
      acquired: true,
      deleted: 3,
    });
    assert.equal(failing.warnings.length, 2);
    assert.equal(failing.warnings.some((line) => line.includes("doc-a1")), false, "no ids in the log line");
  });

  test("answers null when the registry keeps no trash", async () => {
    const service = createDocumentTrashService({ purgeBatch: async () => null });

    assert.equal(await service.deleteExpiredTrash({ cutoff: "2026-10-01T00:00:00.000Z", limit: 10 }), null);
  });

  test("a move into the trash cancels the ingest jobs but redacts nothing", async () => {
    const canceled = [];
    const cascade = createDocumentDeletionCascade({
      ingestJobStore: {
        cancelDocumentJobs: async ({ docIds }) => {
          canceled.push(...docIds);
          return docIds.map((docId) => ({ docId }));
        },
      },
      isRedactionEnabled: () => true,
      logger: silentLogger,
    });

    assert.deepEqual(await cascade.afterDocumentsDeleted({ accessScope: {}, docIds: ["doc-1"], redact: false }), {
      ingestJobs: { canceled: 1 },
      redaction: null,
    });
    assert.deepEqual(canceled, ["doc-1"]);
  });
});

describe("the retention sweep's document_trash type", () => {
  test("is counted in hours, on the API tier, with no workspace cutoffs", async () => {
    await withEnv({ DOCUMENT_TRASH_RETENTION_HOURS: "36", FEEDBACK_RETENTION_DAYS: "30" }, async () => {
      const calls = [];
      const services = {
        documentTrashService: {
          deleteExpiredTrash: async (input) => {
            calls.push(input);
            return { acquired: true, deleted: 0 };
          },
        },
        feedbackService: { deleteExpiredFeedback: async () => ({ acquired: true, deleted: 0 }) },
      };
      const targets = resolveRetentionTargets({ hostsApiTier: true, services });
      const trash = targets.database.find((target) => target.id === RETENTION_DATA_TYPES.documentTrash);

      assert.equal(trash.hours, 36);
      assert.equal(trash.workspacePolicies, false);
      assert.equal(
        resolveRetentionTargets({ hostsAgentTier: true, services }).database.some(
          (target) => target.id === RETENTION_DATA_TYPES.documentTrash
        ),
        false,
        "the agent tier does not purge documents"
      );

      // The workspace policies cannot be read: the feedback delete is skipped
      // (a policy could keep it), the trash purge is not (no policy adjusts it).
      const now = Date.parse("2026-10-10T12:00:00.000Z");
      const report = await createRetentionSweeper({
        intervalMs: 0,
        loadPolicies: async () => {
          throw new Error("registry down");
        },
        logger: silentLogger,
        now: () => now,
        targets,
      }).sweep();

      assert.equal(report[RETENTION_DATA_TYPES.feedback].skipped, "workspace_policies_unavailable");
      assert.equal(report[RETENTION_DATA_TYPES.documentTrash].deleted, 0);
      assert.deepEqual(calls, [
        { cutoff: "2026-10-09T00:00:00.000Z", limit: 500, workspaceCutoffs: [] },
      ]);
    });
  });

  test("starts nothing while the setting is 0", async () => {
    await withEnv({}, () => {
      const targets = resolveRetentionTargets({
        hostsApiTier: true,
        services: { documentTrashService: { deleteExpiredTrash: async () => null } },
      });

      assert.deepEqual(targets.database, []);
    });
  });
});

describe("the route tables", () => {
  test("the trash routes need documents.read and documents.delete, and a restore costs an ingest", () => {
    assert.equal(matchRbacRoute("GET", "/documents/trash").entry.permission, RBAC_PERMISSION_IDS.documentsRead);
    assert.equal(
      matchRbacRoute("POST", "/documents/doc-1/restore").entry.permission,
      RBAC_PERMISSION_IDS.documentsDelete
    );
    assert.equal(classifyTenantLimitRequest("POST", "/documents/doc-1/restore").costClass, TENANT_LIMIT_CLASSES.ingest);
    assert.equal(classifyTenantLimitRequest("GET", "/documents/trash").costClass, TENANT_LIMIT_CLASSES.default);
  });
});
