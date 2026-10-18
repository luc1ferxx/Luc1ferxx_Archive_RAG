// Data-plane audit events (ADMIN_AUDIT_DATA_EVENTS) through the real app:
// what each audited route records (ids and counts only, under the caller's
// own principal), that nothing is recorded with the flag off, and the routes
// that fail closed when their audit record cannot be written (documents
// clear, document delete, an applied tenant erase, and the state-changing
// admin actions) next to the ones that keep answering. ragService and the
// tenant erase are stand-ins, so no database or model is needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { createFileFeedbackStore } from "../feedback.js";
import {
  ADMIN_AUDIT_EVENT_TYPES,
  createAdminAuditService,
  createInMemoryAdminAuditStore,
  DATA_ACCESS_ACTION_IDS,
  DATA_ACCESS_ACTIONS,
} from "../rag/admin-audit.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import { isAdminAuditRequiredForPermission, requireAdminPermission } from "../rag/admin-authorization.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { verifyAdminAuditChains } from "../rag/admin-audit-chain.js";
import { AUDIT_UNAVAILABLE_CODE, createDataAccessAudit } from "../rag/data-access-audit.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { RBAC_PERMISSION_IDS } from "../rag/rbac.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";

process.env.VECTOR_STORE_PROVIDER = "local";

const ENV_KEYS = [
  "ADMIN_AUDIT_DATA_EVENTS",
  "AGENT_SERVICE_URL",
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "ARCHIVE_RAG_ROLE",
  "RAG_INGEST_MODE",
  "RATE_LIMIT_ENABLED",
  "RBAC_DEFAULT_ROLE",
  "RBAC_MODE",
  "RBAC_POLICY_FILE",
  "RBAC_POLICY_JSON",
];

const TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  // A platform admin: roles, a user, no workspace and no workspace list.
  "ops-token": { roles: ["admin.owner"], userId: "ops" },
  // An admin of one workspace: reads that workspace only.
  "ws-admin-token": { roles: ["admin.owner"], userId: "lead", workspaceId: "ws-a" },
};

// Content the stand-in stores hold; none of it may reach an audit event.
const SECRET_FILE_NAME = "quarterly-secret-plan.pdf";
const SECRET_FILE_TEXT = "TOP-SECRET-CONTENT";
const SECRET_MEMORY_TEXT = "my salary is 12345";

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

const createStandInRagService = (calls) => {
  const document = { docId: "doc-1", fileName: SECRET_FILE_NAME, ownerUserId: "alice", version: 1, workspaceId: "ws-a" };

  return {
    clearDocuments: async () => {
      calls.push("clearDocuments");
      return [document, { ...document, docId: "doc-2" }];
    },
    clearLongMemories: async () => {
      calls.push("clearLongMemories");
      return 3;
    },
    clearSessionMemory: async () => {
      calls.push("clearSessionMemory");
      return true;
    },
    deleteDocument: async (docId) => {
      calls.push("deleteDocument");
      return docId === "doc-1" ? document : null;
    },
    deleteLongMemory: async ({ memoryId }) => {
      calls.push("deleteLongMemory");
      return memoryId === "memory-1" ? { memoryId, text: SECRET_MEMORY_TEXT } : null;
    },
    getDocument: (docId) => (docId === "doc-1" ? document : null),
    getDocumentFile: async (docId) =>
      docId === "doc-1"
        ? {
            document,
            fileBuffer: Buffer.from(`%PDF-1.4 ${SECRET_FILE_TEXT}`),
            fileName: SECRET_FILE_NAME,
            mimeType: "application/pdf",
          }
        : null,
    initializeDocumentRegistry: async () => [],
    initializeLongMemory: async () => true,
    initializeSessionMemory: async () => true,
    listDocuments: () => [document],
    replaceDocument: async ({ docId }) => {
      calls.push("replaceDocument");
      return { ...document, docId, version: 2 };
    },
  };
};

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const buildApp = async (tempRoot, { adminAuditService, calls, actionCalls = [], ...extra }) =>
  createProductionApp({
    ...extra,
    adminActionRegistry: {
      listPublic: () => [],
      runAction: async ({ actionId }) => {
        actionCalls.push(actionId);
        return { actionId, status: "ok" };
      },
    },
    adminAuditService,
    adminStatusService: { buildStatus: async () => ({ status: "ok" }) },
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    feedbackStore: createFileFeedbackStore(),
    healthService: okHealthService,
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: createStandInRagService(calls),
    taskStore: createInMemoryTaskStore(),
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
  });

const startServer = async (app) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const call = async (server, { body, method = "GET", path: requestPath, token = "alice-token" }) => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, {
    body,
    headers: { "x-api-key": token },
    method,
  });
  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { headers: response.headers, json, status: response.status, text };
};

// A stand-in for the tenant erase (rag/tenant-lifecycle.js), so the route's
// audit wiring is tested without touching any store.
const createStandInTenantLifecycle = (eraseCalls, { status = "completed" } = {}) => ({
  eraseTenant: async (input) => {
    eraseCalls.push({ dryRun: input.dryRun, userId: input.userId, workspaceId: input.workspaceId });

    return {
      activeWork: {},
      complete: !input.dryRun && status === "completed",
      dryRun: input.dryRun,
      skippedStores: [],
      status: input.dryRun ? "dry_run" : status,
      stores: [],
      tenant: { userId: input.userId, workspaceId: input.workspaceId },
      totals: input.dryRun || status !== "completed"
        ? { records: { documents: 1, tasks: 2 } }
        : { deleted: { documents: 1, tasks: 2 }, records: { documents: 1, tasks: 2 } },
    };
  },
  exportTenant: () => (async function* lines() {})(),
});

const postJson = async (server, requestPath, body, token = "ops-token") => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-api-key": token },
    method: "POST",
  });
  const text = await response.text();

  return { headers: response.headers, json: JSON.parse(text), status: response.status };
};

const createAuditService = () =>
  createAdminAuditService({ store: createInMemoryAdminAuditStore({ maxEvents: 1000 }) });

const listDataEvents = async (service) =>
  (await service.listEvents({ limit: 1000 })).events
    .filter((event) => event.type === ADMIN_AUDIT_EVENT_TYPES.dataAccess)
    .reverse();

const replaceBody = () => {
  const form = new FormData();

  form.append(
    "file",
    new Blob([buildTextPdf({ pages: [["Replacement text."]] })], { type: "application/pdf" }),
    "replacement.pdf"
  );

  return form;
};

test("every data action names a permission the route table or the admin catalog defines", () => {
  const known = new Set([...Object.values(RBAC_PERMISSION_IDS), ...Object.values(ADMIN_PERMISSION_IDS)]);

  for (const action of Object.values(DATA_ACCESS_ACTIONS)) {
    assert.ok(known.has(action.permissionId), `${action.id}: ${action.permissionId}`);
  }

  assert.deepEqual(
    Object.values(DATA_ACCESS_ACTIONS).filter((action) => action.destructive).map((action) => action.id).sort(),
    [
      DATA_ACCESS_ACTION_IDS.documentDelete,
      DATA_ACCESS_ACTION_IDS.documentsClear,
      DATA_ACCESS_ACTION_IDS.tenantErase,
    ]
  );
});

describe("with ADMIN_AUDIT_DATA_EVENTS on", () => {
  const state = {};

  before(async () => {
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "audit-data-events-"));
    state.restoreEnv = applyEnv({
      ADMIN_AUDIT_DATA_EVENTS: "true",
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: JSON.stringify(TOKENS),
    });
  });

  after(async () => {
    state.restoreEnv?.();
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  test("each audited route records its action with ids and counts only, under the caller's principal", async () => {
    const calls = [];
    const adminAuditService = createAuditService();
    const server = await startServer(await buildApp(state.tempRoot, { adminAuditService, calls }));

    try {
      assert.equal((await call(server, { path: "/documents/doc-1/file" })).status, 200);
      assert.equal((await call(server, { path: "/documents/doc-404/file" })).status, 404);
      assert.equal((await call(server, { path: "/documents/doc-1/file?version=7" })).status, 409);
      assert.equal((await call(server, { method: "DELETE", path: "/documents/doc-1" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/documents/doc-404" })).status, 404);
      assert.equal((await call(server, { method: "POST", path: "/documents/clear" })).status, 200);
      assert.equal((await call(server, { body: replaceBody(), method: "PUT", path: "/documents/doc-1" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/memory/memory-1" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/memory" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/sessions/session-9" })).status, 200);
    } finally {
      await server.close();
    }

    const events = await listDataEvents(adminAuditService);
    const summary = events.map((event) => [
      event.dataAccess.actionId,
      event.dataAccess.outcome,
      event.dataAccess.resourceIds,
      event.dataAccess.count,
      event.dataAccess.status,
    ]);

    assert.deepEqual(summary, [
      [DATA_ACCESS_ACTION_IDS.documentFileDownload, "succeeded", ["doc-1"], null, 200],
      [DATA_ACCESS_ACTION_IDS.documentFileDownload, "not_found", ["doc-404"], null, 404],
      [DATA_ACCESS_ACTION_IDS.documentFileDownload, "refused", ["doc-1"], null, 409],
      [DATA_ACCESS_ACTION_IDS.documentDelete, "requested", ["doc-1"], null, null],
      [DATA_ACCESS_ACTION_IDS.documentDelete, "succeeded", ["doc-1"], 1, 200],
      [DATA_ACCESS_ACTION_IDS.documentDelete, "requested", ["doc-404"], null, null],
      [DATA_ACCESS_ACTION_IDS.documentDelete, "not_found", ["doc-404"], 0, 404],
      [DATA_ACCESS_ACTION_IDS.documentsClear, "requested", [], null, null],
      [DATA_ACCESS_ACTION_IDS.documentsClear, "succeeded", ["doc-1", "doc-2"], 2, 200],
      [DATA_ACCESS_ACTION_IDS.documentReplace, "succeeded", ["doc-1"], null, 200],
      [DATA_ACCESS_ACTION_IDS.memoryDelete, "succeeded", ["memory-1"], 1, 200],
      [DATA_ACCESS_ACTION_IDS.memoryClear, "succeeded", [], 3, 200],
      [DATA_ACCESS_ACTION_IDS.sessionDelete, "succeeded", ["session-9"], 1, 200],
    ]);

    for (const event of events) {
      assert.equal(event.principal.userId, "alice");
      assert.equal(event.principal.workspaceId, "ws-a");
      assert.equal(event.result, "allowed");
      assert.equal(event.authorization.actionId, event.dataAccess.actionId);
      assert.equal(event.authorization.permissionId, DATA_ACCESS_ACTIONS[event.dataAccess.actionId].permissionId);
    }

    assert.equal(events.find((event) => event.dataAccess.actionId === DATA_ACCESS_ACTION_IDS.memoryClear).dataAccess.target.userId, "alice");

    const serialized = JSON.stringify(events);

    for (const secret of [SECRET_FILE_NAME, SECRET_FILE_TEXT, SECRET_MEMORY_TEXT, "replacement.pdf", "alice-token"]) {
      assert.ok(!serialized.includes(secret), `no audit event carries ${secret}`);
    }

    // The data events extend the tenant's own chain.
    const chainRows = await adminAuditService.listChainRows();

    assert.equal(verifyAdminAuditChains(chainRows).status, "ok");
  });

  test("a platform admin's cross-tenant reads are recorded; a workspace admin's reads are not", async () => {
    const adminAuditService = createAuditService();
    const server = await startServer(await buildApp(state.tempRoot, { adminAuditService, calls: [] }));

    try {
      // A workspaceId in the query picks that workspace as the admin's scope
      // (resolveWorkspaceId), which is a workspace read, not a platform one;
      // the userId filter is only a filter.
      assert.equal(
        (await call(server, { path: "/admin/audit?workspaceId=ws-b", token: "ops-token" })).status,
        200
      );
      assert.equal((await call(server, { path: "/admin/audit?userId=bob", token: "ops-token" })).status, 200);
      assert.equal((await call(server, { path: "/admin/status", token: "ops-token" })).status, 200);
      assert.equal((await call(server, { path: "/admin/audit", token: "ws-admin-token" })).status, 200);
      assert.equal((await call(server, { path: "/admin/status", token: "ws-admin-token" })).status, 200);
    } finally {
      await server.close();
    }

    const events = await listDataEvents(adminAuditService);

    assert.deepEqual(
      events.map((event) => [event.dataAccess.actionId, event.principal.userId, event.dataAccess.target]),
      [
        [DATA_ACCESS_ACTION_IDS.adminAuditCrossTenantRead, "ops", { userId: "bob", workspaceId: "" }],
        [DATA_ACCESS_ACTION_IDS.adminStatusCrossTenantRead, "ops", { userId: "", workspaceId: "" }],
      ]
    );
    assert.equal(typeof events[0].dataAccess.count, "number");
  });

  test("an applied tenant erase records its intent before the erase and its outcome after; a dry run records none", async () => {
    const eraseCalls = [];
    const adminAuditService = createAuditService();
    const server = await startServer(
      await buildApp(state.tempRoot, {
        adminAuditService,
        calls: [],
        tenantLifecycleService: createStandInTenantLifecycle(eraseCalls),
      })
    );
    const refusingServer = await startServer(
      await buildApp(state.tempRoot, {
        adminAuditService,
        calls: [],
        tenantLifecycleService: createStandInTenantLifecycle([], { status: "refused" }),
      })
    );
    const target = { userId: "alice", workspaceId: "ws-a" };

    try {
      assert.equal((await postJson(server, "/admin/tenants/erase", target)).status, 200);
      assert.equal((await postJson(server, "/admin/tenants/erase", { ...target, dryRun: false })).status, 200);
      assert.equal(
        (await postJson(refusingServer, "/admin/tenants/erase", { dryRun: false, workspaceId: "ws-b" })).status,
        409
      );
    } finally {
      await server.close();
      await refusingServer.close();
    }

    assert.deepEqual(eraseCalls, [
      { dryRun: true, userId: "alice", workspaceId: "ws-a" },
      { dryRun: false, userId: "alice", workspaceId: "ws-a" },
    ]);

    const events = (await listDataEvents(adminAuditService)).filter(
      (event) => event.dataAccess.actionId === DATA_ACCESS_ACTION_IDS.tenantErase
    );

    assert.deepEqual(
      events.map((event) => [
        event.dataAccess.outcome,
        event.dataAccess.target,
        event.dataAccess.count,
        event.dataAccess.status,
        event.dataAccess.resourceType,
        event.principal.userId,
        event.authorization.permissionId,
      ]),
      [
        ["requested", target, null, null, "tenant", "ops", ADMIN_PERMISSION_IDS.adminTenantsErase],
        ["succeeded", target, 3, 200, "tenant", "ops", ADMIN_PERMISSION_IDS.adminTenantsErase],
        ["requested", { userId: "", workspaceId: "ws-b" }, null, null, "tenant", "ops", ADMIN_PERMISSION_IDS.adminTenantsErase],
        ["refused", { userId: "", workspaceId: "ws-b" }, 0, 409, "tenant", "ops", ADMIN_PERMISSION_IDS.adminTenantsErase],
      ]
    );
    assert.equal(verifyAdminAuditChains(await adminAuditService.listChainRows()).status, "ok");
  });

  test("an applied tenant erase does not run when its audit intent cannot be written; a dry run still answers", async () => {
    const eraseCalls = [];
    const working = createAuditService();
    const adminAuditService = {
      ...working,
      recordDataAccess: async () => {
        throw Object.assign(new Error("audit table unavailable"), { code: "57P01" });
      },
    };
    const server = await startServer(
      await buildApp(state.tempRoot, {
        adminAuditService,
        calls: [],
        tenantLifecycleService: createStandInTenantLifecycle(eraseCalls),
      })
    );
    const warn = console.warn;

    console.warn = () => {};

    try {
      const refused = await postJson(server, "/admin/tenants/erase", { dryRun: false, workspaceId: "ws-a" });

      assert.equal(refused.status, 503);
      assert.equal(refused.json.code, AUDIT_UNAVAILABLE_CODE);
      assert.equal(refused.headers.get("retry-after"), "5");
      assert.deepEqual(eraseCalls, [], "nothing was erased");

      assert.equal((await postJson(server, "/admin/tenants/erase", { workspaceId: "ws-a" })).status, 200);
      assert.deepEqual(eraseCalls, [{ dryRun: true, userId: null, workspaceId: "ws-a" }]);
    } finally {
      console.warn = warn;
      await server.close();
    }
  });

  test("documents clear and document delete do not run when their audit record cannot be written; reads and other writes still answer", async () => {
    const calls = [];
    const working = createAuditService();
    const adminAuditService = {
      ...working,
      recordDataAccess: async () => {
        throw Object.assign(new Error("audit table unavailable"), { code: "57P01" });
      },
    };
    const server = await startServer(await buildApp(state.tempRoot, { adminAuditService, calls }));
    const warn = console.warn;
    const warnings = [];

    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      for (const request of [
        { method: "DELETE", path: "/documents/doc-1" },
        { method: "POST", path: "/documents/clear" },
      ]) {
        const response = await call(server, request);

        assert.equal(response.status, 503, request.path);
        assert.equal(response.json.code, AUDIT_UNAVAILABLE_CODE);
        assert.equal(response.json.retryable, true);
        assert.equal(response.headers.get("retry-after"), "5");
      }

      assert.deepEqual(calls, [], "neither the delete nor the clear ran");

      // Not destructive: a failed record is logged and the request answers.
      assert.equal((await call(server, { path: "/documents/doc-1/file" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/memory/memory-1" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/sessions/session-9" })).status, 200);
      assert.deepEqual(calls, ["deleteLongMemory", "clearSessionMemory"]);
    } finally {
      console.warn = warn;
      await server.close();
    }

    assert.ok(warnings.length >= 4);
    assert.ok(warnings.every((line) => line.includes("(57P01)") && !line.includes("audit table unavailable")));
  });
});

describe("with ADMIN_AUDIT_DATA_EVENTS unset (the default)", () => {
  const state = {};

  before(async () => {
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "audit-data-events-off-"));
    state.restoreEnv = applyEnv({
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: JSON.stringify(TOKENS),
    });
  });

  after(async () => {
    state.restoreEnv?.();
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  test("no data event is recorded, and a broken audit sink blocks no data route", async () => {
    const calls = [];
    const adminAuditService = createAuditService();
    const failingService = {
      ...adminAuditService,
      recordDataAccess: async () => assert.fail("no data event is written with the flag off"),
    };
    const server = await startServer(await buildApp(state.tempRoot, { adminAuditService: failingService, calls }));

    try {
      assert.equal((await call(server, { path: "/documents/doc-1/file" })).status, 200);
      assert.equal((await call(server, { method: "DELETE", path: "/documents/doc-1" })).status, 200);
      assert.equal((await call(server, { method: "POST", path: "/documents/clear" })).status, 200);
      assert.equal((await call(server, { path: "/admin/audit", token: "ops-token" })).status, 200);
    } finally {
      await server.close();
    }

    assert.deepEqual(calls, ["deleteDocument", "clearDocuments"]);
    assert.deepEqual(await listDataEvents(adminAuditService), []);
  });

  test("an applied tenant erase records no data event and is not blocked by a broken data sink", async () => {
    const eraseCalls = [];
    const adminAuditService = createAuditService();
    const failingService = {
      ...adminAuditService,
      recordDataAccess: async () => assert.fail("no data event is written with the flag off"),
    };
    const server = await startServer(
      await buildApp(state.tempRoot, {
        adminAuditService: failingService,
        calls: [],
        tenantLifecycleService: createStandInTenantLifecycle(eraseCalls),
      })
    );

    try {
      assert.equal(
        (await postJson(server, "/admin/tenants/erase", { dryRun: false, userId: "alice", workspaceId: "ws-a" })).status,
        200
      );
    } finally {
      await server.close();
    }

    assert.deepEqual(eraseCalls, [{ dryRun: false, userId: "alice", workspaceId: "ws-a" }]);
    assert.deepEqual(await listDataEvents(adminAuditService), []);
  });

  test("state-changing admin actions refuse when their authorization record cannot be written; reads do not", async () => {
    const actionCalls = [];
    const working = createAuditService();
    const adminAuditService = {
      ...working,
      recordAuthorizationDecision: async () => {
        throw new Error("audit table unavailable");
      },
    };
    const server = await startServer(
      await buildApp(state.tempRoot, { actionCalls, adminAuditService, calls: [] })
    );

    try {
      for (const action of ["recover-tasks", "quality-refresh"]) {
        const response = await call(server, { method: "POST", path: `/admin/actions/${action}`, token: "ops-token" });

        assert.equal(response.status, 503, action);
        assert.equal(response.json.code, AUDIT_UNAVAILABLE_CODE);
      }

      assert.equal(
        (await call(server, { method: "POST", path: "/admin/actions/recovery-scan", token: "ops-token" })).status,
        200
      );
      assert.equal((await call(server, { path: "/admin/status", token: "ops-token" })).status, 200);
      // A requeue needs the recovery permission too; the job store has none,
      // so it would be a 404, but it never gets that far.
      assert.equal(
        (await call(server, { method: "POST", path: "/admin/ingest-jobs/job-1/requeue", token: "ops-token" })).status,
        503
      );
    } finally {
      await server.close();
    }

    assert.deepEqual(actionCalls, ["recovery-scan"]);
  });
});

test("the route helper: off records nothing, an unknown action fails closed, an outcome write failure is swallowed", async () => {
  const service = createAuditService();
  const answers = [];
  const res = {
    json: (payload) => {
      answers.push(payload);
      return res;
    },
    set: () => res,
    status: () => res,
  };
  const req = { method: "DELETE", path: "/documents/doc-1", route: { path: "/documents/:docId" } };
  const off = createDataAccessAudit({ auditService: service, isEnabled: () => false });
  const on = createDataAccessAudit({ auditService: service, isEnabled: () => true });

  assert.equal(await off.recordIntent(req, res, { actionId: DATA_ACCESS_ACTION_IDS.documentDelete }), true);
  await off.recordOutcome(req, { actionId: DATA_ACCESS_ACTION_IDS.documentDelete, status: 200 });
  assert.deepEqual(await listDataEvents(service), []);

  const warn = console.warn;

  console.warn = () => {};

  try {
    assert.equal(await on.recordIntent(req, res, { actionId: "document.shred" }), false);
    assert.equal(answers[0].code, AUDIT_UNAVAILABLE_CODE);
    await on.recordOutcome(req, { actionId: "document.shred", status: 200 });
  } finally {
    console.warn = warn;
  }

  assert.equal(
    await on.recordIntent(req, res, {
      accessScope: { userId: "alice", workspaceId: "ws-a" },
      actionId: DATA_ACCESS_ACTION_IDS.documentDelete,
      resourceIds: ["doc-1", "x".repeat(400), ...Array.from({ length: 150 }, (_, index) => `doc-${index}`)],
    }),
    true
  );

  const [event] = await listDataEvents(service);

  assert.equal(event.dataAccess.resourceIds.length, 100);
  assert.equal(event.dataAccess.resourceIdsTruncated, true);
  assert.equal(event.dataAccess.resourceIds[1].length, 256, "ids are bounded");
});

describe("requireAdminPermission's audit requirement", () => {
  const runMiddleware = async (permissionId, { auditFails, requireAudit, scope }) => {
    let nextCalled = false;
    let status = 200;
    let body = null;
    const res = {
      json: (payload) => {
        body = payload;
        return res;
      },
      status: (code) => {
        status = code;
        return res;
      },
    };

    await requireAdminPermission(permissionId, {
      auditService: {
        recordAuthorizationDecision: async () => {
          if (auditFails) throw new Error("down");
        },
      },
      isAuthEnabled: () => true,
      requireAudit,
    })(
      { accessScope: scope, method: "POST", params: {}, path: "/x", route: { path: "/x" } },
      res,
      () => {
        nextCalled = true;
      }
    );

    return { body, nextCalled, status };
  };

  const operator = { authenticated: true, roleIds: ["admin.operator"], userId: "ops" };

  test("the non-read admin permissions require their record; the read ones do not", () => {
    assert.equal(isAdminAuditRequiredForPermission(ADMIN_PERMISSION_IDS.adminActionRecoverTasks), true);
    assert.equal(isAdminAuditRequiredForPermission(ADMIN_PERMISSION_IDS.adminActionQualityRefresh), true);
    assert.equal(isAdminAuditRequiredForPermission(ADMIN_PERMISSION_IDS.agentRunsRecoveryAction), true);
    assert.equal(isAdminAuditRequiredForPermission(ADMIN_PERMISSION_IDS.adminActionRecoveryScan), false);
    assert.equal(isAdminAuditRequiredForPermission(ADMIN_PERMISSION_IDS.adminStatusRead), false);
    assert.equal(isAdminAuditRequiredForPermission(ADMIN_PERMISSION_IDS.adminAuditRead), false);
    assert.equal(isAdminAuditRequiredForPermission("unknown.permission"), false);
    assert.equal(isAdminAuditRequiredForPermission(""), false);
  });

  test("an allowed write with a failed record is refused, a denied one keeps its 403, and requireAudit overrides", async () => {
    const refused = await runMiddleware(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, { auditFails: true, scope: operator });

    assert.equal(refused.nextCalled, false);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, AUDIT_UNAVAILABLE_CODE);

    const denied = await runMiddleware(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, {
      auditFails: true,
      scope: { authenticated: true, roleIds: ["admin.viewer"], userId: "viewer" },
    });

    assert.equal(denied.status, 403);
    assert.equal(denied.nextCalled, false);

    assert.equal(
      (await runMiddleware(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, { auditFails: false, scope: operator })).nextCalled,
      true
    );
    assert.equal(
      (await runMiddleware(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, { auditFails: true, requireAudit: false, scope: operator })).nextCalled,
      true
    );
    assert.equal(
      (await runMiddleware(ADMIN_PERMISSION_IDS.adminStatusRead, { auditFails: true, requireAudit: true, scope: operator })).status,
      503
    );
  });
});
