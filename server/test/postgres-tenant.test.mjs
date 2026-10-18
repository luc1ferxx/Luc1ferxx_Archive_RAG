import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { bindDatabaseTenant } from "../auth.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  getPostgresRowLevelSecurityMode,
  getPostgresTenantContextMode,
  getPostgresTenantRole,
} from "../rag/config.js";
import { renderMigrationSql } from "../rag/db-migrations.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { queryPostgres, TENANT_CONTEXT_MISSING_ERROR_CODE } from "../rag/postgres.js";
import {
  DATABASE_TENANT_CONTEXTS,
  getActiveDatabaseTenant,
  getDatabaseTenantContext,
  runAsDatabaseSystem,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import { createInMemoryTaskStore, createTaskService, TASK_STATUSES } from "../rag/tasks.js";
import { createUploadsRouter } from "../routes/uploads.js";

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });

  try {
    return await callback();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
};

test("a tenant is a trimmed user/workspace pair; an empty scope is no tenant", () => {
  assert.deepEqual(toDatabaseTenant({ userId: " alice ", workspaceId: "" }), {
    userId: "alice",
    workspaceId: "",
  });
  assert.deepEqual(toDatabaseTenant({ workspaceId: "ws-a" }), { userId: "", workspaceId: "ws-a" });
  assert.equal(toDatabaseTenant({ userId: "  ", workspaceId: "" }), null);
  assert.equal(toDatabaseTenant(null), null);
});

test("the tenant follows the async call chain and inner scopes replace outer ones exactly", async () => {
  assert.equal(getActiveDatabaseTenant(), null);

  await runWithDatabaseTenant(ALICE, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(getActiveDatabaseTenant(), ALICE);

    const seenByTimer = await new Promise((resolve) => {
      setTimeout(() => resolve(getActiveDatabaseTenant()), 0);
    });

    assert.deepEqual(seenByTimer, ALICE);
    await runWithDatabaseTenant(BOB, async () => {
      assert.deepEqual(getActiveDatabaseTenant(), BOB);
    });
    // An empty scope acts for nobody: it does not keep the outer tenant.
    await runWithDatabaseTenant({}, async () => {
      assert.equal(getActiveDatabaseTenant(), null);
    });
    await runAsDatabaseSystem(async () => {
      assert.equal(getActiveDatabaseTenant(), null);
    });
    assert.deepEqual(getActiveDatabaseTenant(), ALICE);
  });

  assert.equal(getActiveDatabaseTenant(), null);
});

test("a call chain is in exactly one of four states, and only the tenant state has a tenant", async () => {
  const observe = () => ({ context: getDatabaseTenantContext(), tenant: getActiveDatabaseTenant() });

  assert.deepEqual(observe(), { context: DATABASE_TENANT_CONTEXTS.unbound, tenant: null });

  await runWithDatabaseTenant(ALICE, async () => {
    assert.deepEqual(observe(), { context: "tenant", tenant: ALICE });

    // An empty scope is the explicit unscoped state, not the outer tenant
    // and not unbound.
    await runWithDatabaseTenant({}, async () => {
      assert.deepEqual(observe(), { context: "unscoped", tenant: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(getDatabaseTenantContext(), "unscoped", "it follows the async chain like a tenant");
    });
    await runWithDatabaseTenant({ authenticated: true, userId: " ", workspaceId: "" }, async () => {
      assert.equal(getDatabaseTenantContext(), "unscoped");
    });
    await runAsDatabaseSystem(async () => {
      assert.deepEqual(observe(), { context: "system", tenant: null });

      // Per-record work inside system work binds its record again.
      await runWithDatabaseTenant(BOB, async () => {
        assert.deepEqual(observe(), { context: "tenant", tenant: BOB });
      });
      assert.equal(getDatabaseTenantContext(), "system");
    });
    assert.deepEqual(observe(), { context: "tenant", tenant: ALICE });
  });

  assert.deepEqual(observe(), { context: "unbound", tenant: null });
});

test("no scope can pass for the system or unscoped marker, and a returned tenant is a copy", async () => {
  for (const scope of [
    { databaseContext: "system", userId: "mallory" },
    { databaseContext: "unscoped", workspaceId: "ws-m" },
    { userId: "system" },
  ]) {
    await runWithDatabaseTenant(scope, async () => {
      assert.equal(getDatabaseTenantContext(), "tenant", JSON.stringify(scope));
      assert.equal(Object.hasOwn(getActiveDatabaseTenant(), "databaseContext"), false);
    });
  }

  await runWithDatabaseTenant(ALICE, async () => {
    getActiveDatabaseTenant().userId = "mallory";
    assert.deepEqual(getActiveDatabaseTenant(), ALICE);
  });
});

test("bindDatabaseTenant binds a scope without a tenant as unscoped: auth off, the shared token, a platform path", async () => {
  const contextOf = (req) =>
    new Promise((resolve) => {
      bindDatabaseTenant(req, {}, () => setTimeout(() => resolve(getDatabaseTenantContext()), 0));
    });

  assert.equal(await contextOf({}), "unscoped");
  assert.equal(await contextOf({ accessScope: { authenticated: false, userId: "", workspaceId: "" } }), "unscoped");
  assert.equal(await contextOf({ accessScope: { authenticated: true, roles: ["admin.owner"] } }), "unscoped");
  assert.equal(await contextOf({ accessScope: { authenticated: true, ...ALICE } }), "tenant");
});

test("POSTGRES_TENANT_CONTEXT is lenient by default and refuses an unknown value", async () => {
  await withEnv({ POSTGRES_TENANT_CONTEXT: undefined }, () => {
    assert.equal(getPostgresTenantContextMode(), "lenient");
  });

  for (const blank of ["", "   ", "\t"]) {
    await withEnv({ POSTGRES_TENANT_CONTEXT: blank }, () => {
      assert.equal(getPostgresTenantContextMode(), "lenient");
    });
  }

  await withEnv({ POSTGRES_TENANT_CONTEXT: " STRICT " }, () => {
    assert.equal(getPostgresTenantContextMode(), "strict");
  });

  for (const unknown of ["on", "true", "enforce"]) {
    await withEnv({ POSTGRES_TENANT_CONTEXT: unknown }, () => {
      assert.throws(() => getPostgresTenantContextMode(), /POSTGRES_TENANT_CONTEXT must be one of lenient, strict/);
    });
  }
});

// Without a database the owner path fails on the missing URL; the strict
// refusal comes first and never reaches the pool.
test("strict mode refuses only the unbound state; system, unscoped and tenant calls reach the database layer", async () => {
  const strictEnv = {
    LONG_MEMORY_DATABASE_URL: undefined,
    POSTGRES_DATABASE_URL: undefined,
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_TENANT_CONTEXT: "strict",
  };
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    await withEnv(strictEnv, async () => {
      await assert.rejects(queryPostgres("SELECT 1"), { code: TENANT_CONTEXT_MISSING_ERROR_CODE });

      for (const run of [
        (work) => runAsDatabaseSystem(work),
        (work) => runWithDatabaseTenant({}, work),
        (work) => runWithDatabaseTenant(ALICE, work),
      ]) {
        await assert.rejects(
          run(() => queryPostgres("SELECT 1")),
          (error) => error.code !== TENANT_CONTEXT_MISSING_ERROR_CODE && /POSTGRES_DATABASE_URL/.test(error.message)
        );
      }
    });

    await withEnv({ ...strictEnv, POSTGRES_TENANT_CONTEXT: "lenient" }, async () => {
      await assert.rejects(queryPostgres("SELECT 1"), /POSTGRES_DATABASE_URL/);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("row-level security defaults to enforce, fails closed on unknown values, and validates the role", async () => {
  await withEnv({ POSTGRES_ROW_LEVEL_SECURITY: undefined, POSTGRES_TENANT_ROLE: undefined }, () => {
    assert.equal(getPostgresRowLevelSecurityMode(), "enforce");
    assert.equal(getPostgresTenantRole(), "archive_rag_tenant");
  });
  await withEnv({ POSTGRES_ROW_LEVEL_SECURITY: "disabled" }, () => {
    assert.equal(getPostgresRowLevelSecurityMode(), "enforce");
  });
  await withEnv({ POSTGRES_ROW_LEVEL_SECURITY: " OFF " }, () => {
    assert.equal(getPostgresRowLevelSecurityMode(), "off");
  });
  await withEnv({ POSTGRES_TENANT_ROLE: "tenant; DROP ROLE postgres" }, () => {
    assert.throws(() => getPostgresTenantRole(), /POSTGRES_TENANT_ROLE/);
  });
});

test("migrations render the tenant role and reject an unsafe one", () => {
  const sql = "CREATE POLICY tenant_isolation ON __TASKS_TABLE__ TO __TENANT_ROLE__ USING (true);";
  const tableNames = {
    adminAuditEventsTable: "admin_audit_events",
    agentRunEventsTable: "agent_run_events",
    agentRunsTable: "agent_runs",
    documentChunksTable: "rag_document_chunks",
    documentsTable: "rag_documents",
    longMemoryTable: "long_memory_items",
    sessionMemoryTable: "rag_session_memory",
    taskEventsTable: "rag_task_events",
    tasksTable: "rag_tasks",
    workspaceArtifactsTable: "workspace_artifacts",
  };

  assert.equal(
    renderMigrationSql(sql, tableNames, {
      embeddingDimensions: 8,
      tenantRole: "custom_tenant",
      vectorIndexStatement: "",
    }),
    "CREATE POLICY tenant_isolation ON rag_tasks TO custom_tenant USING (true);"
  );
  assert.throws(
    () =>
      renderMigrationSql(sql, tableNames, {
        embeddingDimensions: 8,
        tenantRole: "tenant role",
        vectorIndexStatement: "",
      }),
    /POSTGRES_TENANT_ROLE/
  );
});

test("the request middleware runs the rest of the chain as the request's tenant", async () => {
  const seen = await new Promise((resolve) => {
    bindDatabaseTenant({ accessScope: ALICE }, {}, () => {
      setTimeout(() => resolve(getActiveDatabaseTenant()), 0);
    });
  });

  assert.deepEqual(seen, ALICE);

  const unscoped = await new Promise((resolve) => {
    bindDatabaseTenant({}, {}, () => resolve(getActiveDatabaseTenant()));
  });

  assert.equal(unscoped, null);
});

// multer's memory storage resumes the chain from a stream callback that has
// lost the async context (disk storage happens to keep it); both upload routes
// re-bind the tenant after multer so neither depends on the storage engine.
test("upload handlers after multer still act for the request's tenant", async () => {
  const uploadsDirectory = await mkdtemp(path.join(os.tmpdir(), "tenant-upload-"));
  const seenTenants = [];
  const recordTenant = (result) => async () => {
    seenTenants.push(getActiveDatabaseTenant());
    return result;
  };
  const app = express();

  app.use((req, res, next) => {
    req.accessScope = ALICE;
    next();
  });
  app.use(bindDatabaseTenant);
  app.use(
    createUploadsRouter({
      ragService: { ingestDocument: recordTenant({ docId: "doc-1" }) },
      uploadStore: { storeUploadChunk: recordTenant({ received: true }) },
      uploadsDirectory,
    })
  );

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const pdf = () =>
    new Blob([Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64 * 1024, 32)])], {
      type: "application/pdf",
    });

  try {
    const chunkBody = new FormData();

    chunkBody.append("fileId", "file-1");
    chunkBody.append("chunkIndex", "0");
    chunkBody.append("totalChunks", "1");
    chunkBody.append("chunk", pdf(), "chunk.bin");

    const directBody = new FormData();

    directBody.append("file", pdf(), "a.pdf");

    const chunk = await fetch(`${baseUrl}/upload/chunk`, { body: chunkBody, method: "POST" });
    const direct = await fetch(`${baseUrl}/upload`, { body: directBody, method: "POST" });

    assert.equal(chunk.status, 201);
    assert.equal(direct.status, 201);
    assert.deepEqual(seenTenants, [ALICE, ALICE]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(uploadsDirectory, { force: true, recursive: true });
  }
});

test("task recovery lists every tenant as system and runs each task as its own tenant", async () => {
  const scheduledWork = [];
  const runTenants = [];
  const baseService = createTaskService({ taskStore: createInMemoryTaskStore() });

  for (const scope of [ALICE, BOB]) {
    await baseService.upsertTask({
      accessScope: scope,
      task: {
        id: `task-${scope.userId}`,
        runnerId: "test_runner",
        status: TASK_STATUSES.queued,
        type: "agent_task",
      },
    });
  }

  let listingTenant = "unset";
  const taskService = {
    ...baseService,
    listRecoverableTasks: async (options) => {
      listingTenant = getActiveDatabaseTenant();
      return baseService.listRecoverableTasks(options);
    },
  };
  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        run: () => {
          runTenants.push(getActiveDatabaseTenant());
          return { status: TASK_STATUSES.completed };
        },
      },
    },
    schedule: (work) => scheduledWork.push(work),
    taskService,
  });

  // An admin triggers recovery from inside their own request.
  await runWithDatabaseTenant(ALICE, () => orchestrator.recoverRunnableTasks());
  assert.equal(listingTenant, null);
  assert.equal(scheduledWork.length, 2);

  await runWithDatabaseTenant(ALICE, () => Promise.all(scheduledWork.map((work) => work())));
  assert.deepEqual(
    runTenants.map((tenant) => tenant.userId).sort(),
    ["alice", "bob"]
  );
});

test("agent run startup recovery scans as system and recovers each run as its own tenant", async () => {
  const observed = [];
  const runs = [
    { accessScope: ALICE, runId: "run-a", status: "running", steps: [] },
    { accessScope: BOB, runId: "run-b", status: "running", steps: [] },
  ];
  const recovery = createAgentRunRecoveryService({
    agentRunService: {
      getRun: async ({ runId }) => {
        observed.push({ call: "getRun", runId, tenant: getActiveDatabaseTenant() });
        return runs.find((run) => run.runId === runId);
      },
      listRecoverableRuns: async () => {
        observed.push({ call: "list", tenant: getActiveDatabaseTenant() });
        return { runs };
      },
      markManualRecovery: async ({ runId }) => ({
        marked: true,
        run: runs.find((run) => run.runId === runId),
      }),
    },
    now: () => "2026-09-25T00:00:00.000Z",
    recordRecoveryTrace: async () => {},
  });

  const outcome = await runWithDatabaseTenant(ALICE, () =>
    recovery.recoverOnStartup({ mode: "manual" })
  );

  assert.equal(outcome.manualRecoveredCount, 2);
  assert.deepEqual(observed.filter((entry) => entry.call === "list"), [
    { call: "list", tenant: null },
  ]);
  assert.deepEqual(
    observed
      .filter((entry) => entry.call === "getRun")
      .map((entry) => [entry.runId, entry.tenant?.userId]),
    [
      ["run-a", "alice"],
      ["run-a", "alice"],
      ["run-b", "bob"],
      ["run-b", "bob"],
    ]
  );
});
