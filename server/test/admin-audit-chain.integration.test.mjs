import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Real-database check of the admin audit hash chains (migration 041): the
// PostgreSQL store chains events written by tenant requests and by the system,
// concurrent writers of one chain extend it one after another under the
// advisory lock, a hash survives the JSONB and timestamptz round trip, and
// audit:verify (the real command, as a child process) finds a changed and a
// deleted row. It runs only when PGVECTOR_TEST_DATABASE_URL points at a
// PostgreSQL where that login may create roles and databases; otherwise it is
// reported as skipped, never as passed. Like the row-level security suite it
// provisions its own database owned by a non-superuser login with CREATEROLE,
// and drops everything afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!adminDatabaseUrl) {
  test("admin audit chain integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `audit_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `audit_it_tenant_${suffix}`;
  const systemRole = `audit_it_system_${suffix}`;
  const databaseName = `audit_it_${suffix}`;
  const withDatabase = (url, name, { user, password } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const adminQuery = async (url, sql) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };

  let modules;
  let databaseUrl;
  let table;
  let eventIndex = 0;

  before(async () => {
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    databaseUrl = withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole });
    process.env.POSTGRES_DATABASE_URL = databaseUrl;
    process.env.POSTGRES_TENANT_ROLE = tenantRole;
    process.env.POSTGRES_SYSTEM_ROLE = systemRole;
    process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
    process.env.VECTOR_STORE_PROVIDER = "pgvector";
    process.env.OPENAI_EMBEDDING_MODEL = "audit-it-embedding";
    process.env.RAG_EMBEDDING_DIMENSIONS = "8";

    const [config, postgres, tenant, migrations, auditStore, audit, chain, verify] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/postgres-tenant.js"),
      import("../rag/db-migrations.js"),
      import("../rag/postgres-admin-audit-store.js"),
      import("../rag/admin-audit.js"),
      import("../rag/admin-audit-chain.js"),
      import("../audit-verify.mjs"),
    ]);

    modules = { audit, auditStore, chain, config, migrations, postgres, tenant, verify };
    config.configureEmbeddingDimensions(8);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await tenant.runAsDatabaseSystem(() => migrations.runPostgresMigrations());
    table = config.getAdminAuditEventsPostgresTable();
  });

  after(async () => {
    await modules?.postgres.resetPostgresPool();
    await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${systemRole}`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
  });

  const createService = () =>
    modules.audit.createAdminAuditService({
      createEventId: () => `it-${suffix}-${++eventIndex}`,
      store: modules.auditStore.createPostgresAdminAuditStore({ retentionDays: 0 }),
    });

  const recordAs = (service, scope) =>
    modules.tenant.runWithDatabaseTenant(scope, () =>
      service.recordAuthorizationDecision({
        accessScope: { authenticated: true, ...scope },
        actionId: "recover-tasks",
        decision: { allowed: true, permissionId: "admin.actions.recover_tasks", reason: "allowed_by_role", roleId: "admin.operator" },
        request: { method: "POST", path: "/admin/actions/recover-tasks", route: "/admin/actions/:action" },
      })
    );

  const verifyWorkspace = (workspaceId) =>
    modules.tenant.runAsDatabaseSystem(() =>
      modules.verify.verifyAdminAuditStoreChains(modules.auditStore.createPostgresAdminAuditStore(), {
        pageSize: 3,
        workspaceId,
      })
    );

  const ownerQuery = (sql, values) =>
    modules.tenant.runAsDatabaseSystem(() => modules.postgres.queryPostgres(sql, values));

  // The real command as a child process, in a cwd without a .env file.
  const runVerifyCommand = async (args) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "audit-verify-"));

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(serverDirectory, "audit-verify.mjs"), ...args], {
          cwd,
          env: {
            PATH: process.env.PATH,
            POSTGRES_DATABASE_URL: databaseUrl,
            POSTGRES_ROW_LEVEL_SECURITY: "enforce",
            POSTGRES_SYSTEM_ROLE: systemRole,
            POSTGRES_TENANT_ROLE: tenantRole,
            RAG_EMBEDDING_DIMENSIONS: "8",
            VECTOR_STORE_PROVIDER: "pgvector",
          },
        });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr, stdout }));
      });
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  };

  // Two chains whose ids commit out of order: chain Y's second event takes
  // its id and waits before COMMIT while chain X commits a later id. Returns
  // the id to scan after (just before Y's first row) and `finish`, which
  // commits Y's second event and appends a third (prev_hash = the second's).
  let raceIndex = 0;
  const stageOutOfOrderCommit = async () => {
    raceIndex += 1;

    const service = createService();
    const y = { userId: "ivy", workspaceId: `it-ws-snapshot-y-${raceIndex}` };
    const x = { userId: "jon", workspaceId: `it-ws-snapshot-x-${raceIndex}` };
    let inserted;
    let release;
    const insertedSignal = new Promise((resolve) => {
      inserted = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const gatedService = modules.audit.createAdminAuditService({
      createEventId: () => `it-${suffix}-${++eventIndex}`,
      store: modules.auditStore.createPostgresAdminAuditStore({
        retentionDays: 0,
        transaction: (callback) =>
          modules.postgres.withPostgresTransaction(async (client) => {
            const result = await callback(client);

            inserted();
            await gate;
            return result;
          }),
      }),
    });

    await recordAs(service, y);

    const [{ id: firstId }] = (
      await ownerQuery(`SELECT max(id)::bigint AS id FROM ${table} WHERE workspace_id = $1`, [y.workspaceId])
    ).rows;
    const pendingY = recordAs(gatedService, y);

    await insertedSignal;
    await recordAs(service, x);

    return {
      afterId: Number(firstId) - 1,
      finish: async () => {
        release();
        await pendingY;
        await recordAs(service, y);
      },
      workspaces: [y.workspaceId, x.workspaceId],
    };
  };

  test("tenant and system writes chain per workspace, and the hashes survive the JSONB and timestamptz round trip", async () => {
    const service = createService();

    // Rows from before migration 041 (no hashes) start nothing.
    await ownerQuery(
      `INSERT INTO ${table} (event_id, event_type, result, user_id, workspace_id) VALUES ($1, 'legacy', 'allowed', 'alice', 'it-ws-a')`,
      [`legacy-${suffix}`]
    );

    await recordAs(service, { userId: "alice", workspaceId: "it-ws-a" });
    await recordAs(service, { userId: "carol", workspaceId: "it-ws-a" });
    await modules.tenant.runWithDatabaseTenant({ userId: "alice", workspaceId: "it-ws-a" }, () =>
      service.recordDataAccess({
        accessScope: { userId: "alice", workspaceId: "it-ws-a" },
        actionId: "documents.clear",
        count: 2,
        outcome: "succeeded",
        resourceIds: ["doc-1", "doc-2"],
        status: 200,
      })
    );
    // The system path (an auth-disabled request names its principal only).
    await modules.tenant.runAsDatabaseSystem(() =>
      service.recordAuthorizationDecision({
        accessScope: { userId: "ops", workspaceId: "it-ws-a" },
        decision: { allowed: true, permissionId: "admin.status.read", reason: "api_auth_disabled", roleId: "" },
        request: { method: "GET", path: "/admin/status", route: "/admin/status" },
      })
    );

    const report = await verifyWorkspace("it-ws-a");

    assert.equal(report.status, "ok", JSON.stringify(report.chains));
    assert.equal(report.legacyRows, 1);
    assert.equal(report.chainedRows, 4);
    assert.equal(report.chains[0].startsAfterPurge, false);

    const rows = (
      await ownerQuery(`SELECT prev_hash, row_hash, data_access FROM ${table} WHERE workspace_id = 'it-ws-a' AND row_hash IS NOT NULL ORDER BY id`)
    ).rows;

    assert.equal(rows[0].prev_hash, null);
    assert.equal(rows[1].prev_hash, rows[0].row_hash);
    assert.deepEqual(rows[2].data_access.resourceIds, ["doc-1", "doc-2"]);
  });

  test("a workspace-less user's chain is that user's alone, and a tenant reads only its own chain's head", async () => {
    const service = createService();

    await recordAs(service, { userId: "dave", workspaceId: "" });
    await recordAs(service, { userId: "erin", workspaceId: "" });
    await recordAs(service, { userId: "dave", workspaceId: "" });

    const rows = (
      await ownerQuery(`SELECT user_id, prev_hash, row_hash FROM ${table} WHERE workspace_id = '' AND user_id IN ('dave', 'erin') ORDER BY id`)
    ).rows;

    assert.deepEqual(rows.map((row) => [row.user_id, row.prev_hash === null]), [["dave", true], ["erin", true], ["dave", false]]);
    assert.equal(rows[2].prev_hash, rows[0].row_hash);
  });

  test("concurrent writers of one chain extend it one after another", async () => {
    const service = createService();
    const scopes = Array.from({ length: 30 }, (_, index) => ({
      userId: ["alice", "carol", "frank"][index % 3],
      workspaceId: index % 2 ? "it-ws-race-1" : "it-ws-race-2",
    }));

    await Promise.all(scopes.map((scope) => recordAs(service, scope)));

    for (const workspaceId of ["it-ws-race-1", "it-ws-race-2"]) {
      const report = await verifyWorkspace(workspaceId);

      assert.equal(report.status, "ok", `${workspaceId}: ${JSON.stringify(report.chains)}`);
      assert.equal(report.chainedRows, 15);
    }
  });

  test("audit:verify finds a changed row and a deleted row, and exits 1", async () => {
    const service = createService();

    for (let index = 0; index < 4; index += 1) {
      await recordAs(service, { userId: "gina", workspaceId: "it-ws-tamper" });
    }

    const ids = (await ownerQuery(`SELECT id, event_id FROM ${table} WHERE workspace_id = 'it-ws-tamper' ORDER BY id`)).rows;
    const runCommand = async (args) => {
      // A cwd without a .env file, so the command reads only this environment.
      const cwd = await mkdtemp(path.join(os.tmpdir(), "audit-verify-"));

      try {
        return await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(serverDirectory, "audit-verify.mjs"), ...args], {
            cwd,
            env: {
              PATH: process.env.PATH,
              POSTGRES_DATABASE_URL: databaseUrl,
              POSTGRES_ROW_LEVEL_SECURITY: "enforce",
              POSTGRES_SYSTEM_ROLE: systemRole,
              POSTGRES_TENANT_ROLE: tenantRole,
              RAG_EMBEDDING_DIMENSIONS: "8",
              VECTOR_STORE_PROVIDER: "pgvector",
            },
          });
          let stdout = "";
          let stderr = "";

          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr, stdout }));
        });
      } finally {
        await rm(cwd, { force: true, recursive: true });
      }
    };

    const clean = await runCommand(["--workspace", "it-ws-tamper", "--json"]);

    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).status, "ok");

    // The owner login can still change a row: the chain shows it.
    await ownerQuery(`UPDATE ${table} SET result = 'denied' WHERE id = $1`, [ids[1].id]);

    const changed = await runCommand(["--workspace", "it-ws-tamper", "--json"]);
    const changedReport = JSON.parse(changed.stdout);

    assert.equal(changed.code, 1);
    assert.deepEqual(changedReport.chains[0].break, {
      eventId: ids[1].event_id,
      kind: "row_hash_mismatch",
      rowId: Number(ids[1].id),
    });

    await ownerQuery(`UPDATE ${table} SET result = 'allowed' WHERE id = $1`, [ids[1].id]);
    await ownerQuery(`DELETE FROM ${table} WHERE id = $1`, [ids[2].id]);

    const deleted = await runCommand(["--workspace", "it-ws-tamper"]);

    assert.equal(deleted.code, 1);
    assert.match(deleted.stdout, /row \d+ \(event "[^"]+"\) does not follow the row before it.*\[prev_hash_mismatch\]/);

    // Removing the chain's oldest rows is what the retention purge does: not a break.
    await ownerQuery(`DELETE FROM ${table} WHERE workspace_id = 'it-ws-tamper' AND id <= $1`, [ids[2].id]);

    const purged = await runCommand(["--workspace", "it-ws-tamper", "--json"]);

    assert.equal(purged.code, 0, purged.stdout);
    assert.equal(JSON.parse(purged.stdout).chains[0].startsAfterPurge, true);
  });

  // Migration 038's `details` (only tenant lifecycle events fill it) is part
  // of the hash: the erase tombstone, written as the system as the erase
  // writes it, verifies after the JSONB round trip, and changing its details
  // on the owner login breaks its chain.
  test("a tenant erase tombstone's details are hashed: it verifies, and changed details break the chain", async () => {
    const service = createService();
    const operator = { authenticated: true, roleIds: ["admin.owner"], userId: `ops-it-${suffix}`, workspaceId: "" };
    const operatorChain = async () => {
      const report = await modules.tenant.runAsDatabaseSystem(() =>
        modules.verify.verifyAdminAuditStoreChains(modules.auditStore.createPostgresAdminAuditStore(), { pageSize: 5 })
      );

      return report.chains.find((chain) => chain.userId === operator.userId && chain.workspaceId === "");
    };

    await modules.tenant.runAsDatabaseSystem(async () => {
      await service.recordAuthorizationDecision({
        accessScope: operator,
        actionId: "",
        decision: { allowed: true, permissionId: "admin.tenants.erase", reason: "allowed_by_role", roleId: "admin.owner" },
        request: { method: "POST", path: "/admin/tenants/erase", route: "/admin/tenants/erase" },
      });
      await service.recordTenantLifecycleEvent({
        accessScope: operator,
        actionId: "tenant.erase",
        details: {
          counts: { "chunks:rag_document_chunks": 4, documents: 2, workspace_members: 3, workspaces: 1 },
          force: false,
          outcome: "completed",
          skippedStores: [],
          tenant: { userId: null, workspaceId: "it-ws-erased" },
        },
        permissionId: "admin.tenants.erase",
        reason: "tenant_erase_completed",
        request: { method: "POST", path: "/admin/tenants/erase", route: "/admin/tenants/erase" },
        type: modules.audit.ADMIN_AUDIT_EVENT_TYPES.tenantErased,
      });
    });

    const clean = await operatorChain();

    assert.equal(clean.rows, 2);
    assert.equal(clean.break, null);

    const [tombstone] = (
      await ownerQuery(`SELECT id, event_id, details FROM ${table} WHERE user_id = $1 AND details IS NOT NULL`, [
        operator.userId,
      ])
    ).rows;

    assert.equal(tombstone.details.counts.workspaces, 1);

    await ownerQuery(
      `UPDATE ${table} SET details = jsonb_set(details, '{counts,documents}', '0'::jsonb) WHERE id = $1`,
      [tombstone.id]
    );
    assert.deepEqual((await operatorChain()).break, {
      eventId: tombstone.event_id,
      kind: "row_hash_mismatch",
      rowId: Number(tombstone.id),
    });

    await ownerQuery(`UPDATE ${table} SET details = NULL WHERE id = $1`, [tombstone.id]);
    assert.equal((await operatorChain()).break?.kind, "row_hash_mismatch", "clearing them too");
  });

  test("audit:verify's scan is one snapshot: a row committing out of id order mid-scan is no false break", async () => {
    const store = modules.auditStore.createPostgresAdminAuditStore();
    const verifyRows = (rows) => modules.chain.verifyAdminAuditChains(rows);

    // The control: a statement (a snapshot) per page, as audit:verify paged
    // before. Page 1 is [Y1, X1] without Y2; page 2 starts after X1's id, so
    // Y2 is never read and Y3 seems not to follow Y1.
    const paged = await stageOutOfOrderCommit();
    const pagedRows = await modules.tenant.runAsDatabaseSystem(async () => {
      const first = await store.listChainRows({ afterId: paged.afterId, limit: 2 });

      await paged.finish();

      return [...first, ...(await store.listChainRows({ afterId: first.at(-1).id, limit: 2 }))];
    });

    assert.equal(pagedRows.length, 3);
    assert.equal(verifyRows(pagedRows).status, "broken");
    assert.equal(
      verifyRows(pagedRows).chains.find((chain) => chain.workspaceId === paged.workspaces[0]).break.kind,
      "prev_hash_mismatch"
    );

    // The store's scan: the commits made while it fetches are not part of it.
    const scanned = await stageOutOfOrderCommit();
    const scannedRows = [];

    await modules.tenant.runAsDatabaseSystem(() =>
      store.scanChainRows({
        afterId: scanned.afterId,
        onPage: async (rows) => {
          if (scannedRows.length === 0) {
            await scanned.finish();
          }

          scannedRows.push(...rows);
        },
        pageSize: 2,
      })
    );

    assert.deepEqual(
      scannedRows.map((row) => row.workspace_id),
      [scanned.workspaces[0], scanned.workspaces[1]],
      "Y2 and Y3 committed after the cursor's snapshot"
    );
    assert.equal(verifyRows(scannedRows).status, "ok");

    // Read afresh, both chains verify in full.
    for (const workspaceId of [...paged.workspaces, ...scanned.workspaces]) {
      assert.equal((await verifyWorkspace(workspaceId)).status, "ok", workspaceId);
    }
  });

  test("audit:verify reads when migration 041 ran: an older instance's unhashed row inside the window is an upgrade row", async () => {
    const service = createService();
    const scope = { userId: "kim", workspaceId: "it-ws-upgrade" };

    await recordAs(service, scope);
    // An instance still on code from before migration 041 names no hash
    // column in its INSERT.
    await ownerQuery(
      `INSERT INTO ${table} (event_id, event_type, result, user_id, workspace_id) VALUES ($1, 'authorization_decision', 'allowed', 'kim', 'it-ws-upgrade')`,
      [`old-replica-${suffix}`]
    );
    await recordAs(service, scope);

    const inWindow = await runVerifyCommand(["--workspace", "it-ws-upgrade", "--json"]);
    const report = JSON.parse(inWindow.stdout);

    assert.equal(inWindow.code, 0, inWindow.stdout + inWindow.stderr);
    assert.equal(report.upgradeRows, 1);
    assert.equal(report.chainedRows, 2);
    assert.equal(report.upgradeWindow.source, "migration");
    assert.ok(Date.parse(report.upgradeWindow.chainedSince) <= Date.now());

    const strict = await runVerifyCommand(["--workspace", "it-ws-upgrade", "--json", "--upgrade-grace-hours", "0"]);

    assert.equal(strict.code, 1);
    assert.equal(JSON.parse(strict.stdout).chains[0].break.kind, "unchained_row");
  });

  test("the tenant role still cannot change or remove an audit row, hashed or not", async () => {
    const service = createService();
    const scope = { userId: "hank", workspaceId: "it-ws-locked" };

    await recordAs(service, scope);

    for (const statement of [
      `UPDATE ${table} SET row_hash = NULL WHERE workspace_id = 'it-ws-locked'`,
      `DELETE FROM ${table} WHERE workspace_id = 'it-ws-locked'`,
    ]) {
      await assert.rejects(
        modules.tenant.runWithDatabaseTenant(scope, () => modules.postgres.queryPostgres(statement)),
        (error) => error.code === "42501"
      );
    }
  });
}
