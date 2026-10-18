// The tenant registry (rag/tenant-registry.js, migration 036): validation,
// the in-memory store, the PostgreSQL store's statements over a recording
// query function, the lookup cache, the enforcement decision, the migration's
// SQL, the TENANT_MEMBERSHIP setting and the operator CLI. Real-database
// coverage of the row policies is in
// postgres-row-level-security.integration.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { getTenantMembershipMode, getTenantRegistryCacheTtlMs } from "../rag/config.js";
import { getTenantRegistryTableNames, renderMigrationSql } from "../rag/db-migrations.js";
import {
  getActiveDatabaseTenant,
  getDatabaseTenantContext,
} from "../rag/postgres-tenant.js";
import {
  createInMemoryTenantRegistryStore,
  createPostgresTenantRegistryStore,
  createTenantRegistryService,
  decideTenantMembership,
  MAX_MEMBER_ROLES,
  MAX_SCOPE_WORKSPACE_ROLES,
  mergeMembershipRoles,
  normalizeMemberRolesInput,
  resolveMembershipScope,
  normalizeWorkspaceIdInput,
  TENANT_MEMBERSHIP_CODES,
  TENANT_REGISTRY_ERROR_CODES,
  TenantRegistryError,
  WORKSPACE_STATUSES,
} from "../rag/tenant-registry.js";
import {
  MAX_FORWARDED_WORKSPACE_ROLES,
  normalizeServiceAccessScope,
} from "../rag/service-identity.js";
import {
  parseTenantRegistryArgs,
  runTenantRegistryCommand,
  USAGE,
} from "../tenant-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withEnv = async (values, run) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const isRegistryError = (code, status) => (error) => {
  assert.ok(error instanceof TenantRegistryError, `expected a TenantRegistryError, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return true;
};

const invalidInput = isRegistryError(TENANT_REGISTRY_ERROR_CODES.invalidInput, 400);

const createMemoryRegistry = (options = {}) =>
  createTenantRegistryService({ store: createInMemoryTenantRegistryStore(), ...options });

describe("validation", () => {
  test("workspace ids must be canonical: trimmed, lower case, bounded, no control characters", () => {
    assert.equal(normalizeWorkspaceIdInput("  ws-a "), "ws-a");
    assert.equal(normalizeWorkspaceIdInput("acme corp"), "acme corp");
    for (const value of ["", "   ", "Acme", "acme  corp", "ws\u0000a", "ws\na", "x".repeat(257), 7, null, undefined]) {
      assert.throws(() => normalizeWorkspaceIdInput(value), invalidInput, JSON.stringify(value));
    }
    assert.equal(normalizeWorkspaceIdInput("x".repeat(256)).length, 256);
  });

  test("member roles are role ids, at most 32, never an admin role", () => {
    assert.deepEqual(normalizeMemberRolesInput(undefined), []);
    assert.deepEqual(normalizeMemberRolesInput([" Workspace.Admin ", "workspace.admin", "custom:role_1"]), [
      "workspace.admin",
      "custom:role_1",
    ]);
    for (const value of ["workspace.admin", [1], ["has space"], ["admin.owner"], ["admin.tenant_manager"], ["-x"]]) {
      assert.throws(() => normalizeMemberRolesInput(value), invalidInput, JSON.stringify(value));
    }
    assert.throws(
      () => normalizeMemberRolesInput(Array.from({ length: 33 }, (_, index) => `role.${index}`)),
      invalidInput
    );
  });

  test("a workspace's descriptors are bounded and its retention policy is a JSON object", async () => {
    const registry = createMemoryRegistry();

    for (const input of [
      [],
      { workspaceId: "ws-a", plan: 7 },
      { workspaceId: "ws-a", plan: "p".repeat(129) },
      { workspaceId: "ws-a", region: "eu\u0007" },
      { workspaceId: "ws-a", retentionPolicy: [] },
      { workspaceId: "ws-a", retentionPolicy: "30d" },
      { workspaceId: "ws-a", retentionPolicy: { note: "nul\u0000" } },
      { workspaceId: "ws-a", retentionPolicy: { blob: "x".repeat(17 * 1024) } },
      // The retention sweep's format (rag/workspace-retention-policy.js):
      // only its keys, each a whole number of days from 0 to 36500.
      { workspaceId: "ws-a", retentionPolicy: { days: 30 } },
      { workspaceId: "ws-a", retentionPolicy: { agent_runs: 30 } },
      { workspaceId: "ws-a", retentionPolicy: { AGENT_RUN_RETENTION_DAYS: 30 } },
      { workspaceId: "ws-a", retentionPolicy: { agentRuns: "30" } },
      { workspaceId: "ws-a", retentionPolicy: { agentRuns: 1.5 } },
      { workspaceId: "ws-a", retentionPolicy: { agentRuns: -1 } },
      { workspaceId: "ws-a", retentionPolicy: { agentRuns: 36_501 } },
      { workspaceId: "ws-a", retentionPolicy: { agentRuns: { days: 30 } } },
      { workspaceId: "ws-a", retentionPolicy: { ragObservability: 7 } },
      { workspaceId: "ws-a", status: "deleting" },
      { workspaceId: "ws-a", status: "paused" },
    ]) {
      await assert.rejects(registry.createWorkspace(input), invalidInput, JSON.stringify(input).slice(0, 60));
    }

    assert.deepEqual(await registry.listWorkspaces(), [], "nothing invalid was stored");
  });

  test("a retention policy the registry accepts is exactly what the retention sweep reads", async () => {
    const { readWorkspaceRetentionDays, RETENTION_DATA_TYPES } = await import("../rag/retention.js");
    const registry = createMemoryRegistry();
    const policy = { agentRuns: 0, feedback: 36_500, tasks: 7, workspaceArtifacts: 30 };
    const created = await registry.createWorkspace({ retentionPolicy: policy, workspaceId: "ws-a" });

    assert.deepEqual(created.retentionPolicy, policy);
    assert.deepEqual((await registry.createWorkspace({ retentionPolicy: {}, workspaceId: "ws-b" })).retentionPolicy, {});
    assert.equal(readWorkspaceRetentionDays(created.retentionPolicy, RETENTION_DATA_TYPES.agentRuns), 0);
    assert.equal(readWorkspaceRetentionDays(created.retentionPolicy, RETENTION_DATA_TYPES.tasks), 7);
    assert.equal(readWorkspaceRetentionDays(created.retentionPolicy, RETENTION_DATA_TYPES.workspaceArtifacts), 30);
    assert.equal(readWorkspaceRetentionDays(created.retentionPolicy, RETENTION_DATA_TYPES.feedback), 36_500);
    // The observability files are per host: no workspace key reaches them.
    assert.equal(readWorkspaceRetentionDays(created.retentionPolicy, RETENTION_DATA_TYPES.ragObservability), undefined);
  });
});

describe("the in-memory registry", () => {
  test("registers, lists, suspends and activates workspaces", async () => {
    let clock = Date.parse("2026-10-17T10:00:00.000Z");
    const registry = createTenantRegistryService({
      store: createInMemoryTenantRegistryStore({ now: () => clock }),
    });

    const created = await registry.createWorkspace({
      plan: " team ",
      region: "eu-west",
      retentionPolicy: { agentRuns: 30, feedback: 0 },
      workspaceId: "ws-b",
    });

    assert.deepEqual(created, {
      workspaceId: "ws-b",
      status: "active",
      plan: "team",
      region: "eu-west",
      retentionPolicy: { agentRuns: 30, feedback: 0 },
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:00.000Z",
    });
    await registry.createWorkspace({ status: "suspended", workspaceId: "ws-a" });
    await registry.createWorkspace({ workspaceId: "ws-c" });
    await assert.rejects(
      registry.createWorkspace({ workspaceId: "ws-b" }),
      isRegistryError(TENANT_REGISTRY_ERROR_CODES.workspaceExists, 409)
    );

    assert.deepEqual((await registry.listWorkspaces()).map((workspace) => workspace.workspaceId), [
      "ws-a",
      "ws-b",
      "ws-c",
    ]);
    assert.deepEqual(
      (await registry.listWorkspaces({ limit: "1", offset: "1" })).map((workspace) => workspace.workspaceId),
      ["ws-b"]
    );
    assert.deepEqual(
      (await registry.listWorkspaces({ status: "suspended" })).map((workspace) => workspace.workspaceId),
      ["ws-a"]
    );
    await assert.rejects(registry.listWorkspaces({ status: "gone" }), invalidInput);
    await assert.rejects(registry.listWorkspaces({ limit: 0 }), invalidInput);
    await assert.rejects(registry.listWorkspaces({ limit: 1001 }), invalidInput);

    clock += 1000;
    const suspended = await registry.suspendWorkspace("ws-b");

    assert.equal(suspended.status, WORKSPACE_STATUSES.suspended);
    assert.equal(suspended.updatedAt, "2026-10-17T10:00:01.000Z");
    assert.equal(suspended.createdAt, "2026-10-17T10:00:00.000Z");
    assert.equal((await registry.activateWorkspace("ws-b")).status, WORKSPACE_STATUSES.active);
    await assert.rejects(
      registry.suspendWorkspace("ws-missing"),
      isRegistryError(TENANT_REGISTRY_ERROR_CODES.workspaceNotFound, 404)
    );

    // Offboarding is one way: a deleting workspace never changes back.
    assert.equal((await registry.setWorkspaceStatus("ws-c", "deleting")).status, "deleting");
    for (const change of [() => registry.activateWorkspace("ws-c"), () => registry.suspendWorkspace("ws-c")]) {
      await assert.rejects(change(), isRegistryError(TENANT_REGISTRY_ERROR_CODES.workspaceDeleting, 409));
    }
    assert.equal((await registry.getWorkspace("ws-c")).status, "deleting");

    // Returned records are copies.
    const listed = await registry.listWorkspaces();
    listed[0].status = "mutated";
    listed[1].retentionPolicy.agentRuns = 1;
    assert.equal((await registry.getWorkspace("ws-a")).status, "suspended");
    assert.equal((await registry.getWorkspace("ws-b")).retentionPolicy.agentRuns, 30);
  });

  test("adds, updates, lists and removes members", async () => {
    const registry = createMemoryRegistry();

    await registry.createWorkspace({ workspaceId: "ws-a" });

    assert.equal(
      (await registry.putMember({ roles: ["workspace.viewer"], userId: "alice", workspaceId: "ws-a" })).created,
      true
    );
    const updated = await registry.putMember({
      roles: ["workspace.admin"],
      userId: "alice",
      workspaceId: "ws-a",
    });

    assert.equal(updated.created, false);
    assert.deepEqual(updated.member.roles, ["workspace.admin"]);
    // User ids keep their case: they are the database tenant's user exactly.
    await registry.putMember({ userId: "Bob", workspaceId: "ws-a" });
    assert.deepEqual(
      (await registry.listMembers("ws-a")).map((member) => [member.userId, member.roles]),
      [
        ["Bob", []],
        ["alice", ["workspace.admin"]],
      ]
    );
    assert.equal(await registry.getMember("ws-a", "bob"), null);

    await assert.rejects(
      registry.putMember({ userId: "carol", workspaceId: "ws-missing" }),
      isRegistryError(TENANT_REGISTRY_ERROR_CODES.workspaceNotFound, 404)
    );
    await assert.rejects(
      registry.listMembers("ws-missing"),
      isRegistryError(TENANT_REGISTRY_ERROR_CODES.workspaceNotFound, 404)
    );
    await assert.rejects(registry.putMember({ userId: " ", workspaceId: "ws-a" }), invalidInput);

    assert.equal(await registry.removeMember("ws-a", "Bob"), true);
    await assert.rejects(
      registry.removeMember("ws-a", "Bob"),
      isRegistryError(TENANT_REGISTRY_ERROR_CODES.memberNotFound, 404)
    );

    await registry.setWorkspaceStatus("ws-a", "deleting");
    await assert.rejects(
      registry.putMember({ userId: "dave", workspaceId: "ws-a" }),
      isRegistryError(TENANT_REGISTRY_ERROR_CODES.workspaceDeleting, 409)
    );
  });
});

describe("the lookup cache", () => {
  const countingStore = () => {
    const store = createInMemoryTenantRegistryStore();
    const counts = { getMember: 0, getWorkspace: 0 };
    const contexts = [];

    return {
      contexts,
      counts,
      store: {
        ...store,
        async getMember(...args) {
          counts.getMember += 1;
          contexts.push({ call: "getMember", context: getDatabaseTenantContext(), tenant: getActiveDatabaseTenant() });
          return store.getMember(...args);
        },
        async getWorkspace(...args) {
          counts.getWorkspace += 1;
          contexts.push({ call: "getWorkspace", context: getDatabaseTenantContext(), tenant: getActiveDatabaseTenant() });
          return store.getWorkspace(...args);
        },
      },
    };
  };

  test("lookups are cached for the TTL, shared while in flight, and dropped by a write", async () => {
    let clock = 1_000;
    const { counts, store } = countingStore();
    const registry = createTenantRegistryService({ cacheTtlMs: 5000, now: () => clock, store });

    // A negative answer is cached too.
    assert.equal(await registry.lookupWorkspace("ws-a"), null);
    assert.equal(await registry.lookupWorkspace("ws-a"), null);
    assert.equal(counts.getWorkspace, 1);

    // Registering drops it at once in this process.
    await registry.createWorkspace({ workspaceId: "ws-a" });
    const getsAfterCreate = counts.getWorkspace;
    assert.deepEqual(await registry.lookupWorkspace("ws-a"), { status: "active", workspaceId: "ws-a" });
    assert.equal(counts.getWorkspace, getsAfterCreate + 1);

    // Concurrent lookups share one read.
    const [first, second] = await Promise.all([
      registry.lookupMembership("ws-a", "alice"),
      registry.lookupMembership("ws-a", "alice"),
    ]);
    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(counts.getMember, 1);

    await registry.putMember({ roles: ["workspace.viewer"], userId: "alice", workspaceId: "ws-a" });
    assert.deepEqual(await registry.lookupMembership("ws-a", "alice"), { roles: ["workspace.viewer"] });
    assert.equal(counts.getMember, 2);

    // Suspending drops the workspace and its memberships.
    await registry.suspendWorkspace("ws-a");
    assert.equal((await registry.lookupWorkspace("ws-a")).status, "suspended");
    await registry.lookupMembership("ws-a", "alice");
    assert.equal(counts.getMember, 3, "the membership entry of the workspace was dropped too");

    // A cached answer is a copy, and expires after the TTL.
    const cached = await registry.lookupMembership("ws-a", "alice");
    cached.roles.push("workspace.admin");
    assert.deepEqual(await registry.lookupMembership("ws-a", "alice"), { roles: ["workspace.viewer"] });
    assert.equal(counts.getMember, 3);
    clock += 5001;
    await registry.lookupMembership("ws-a", "alice");
    assert.equal(counts.getMember, 4);
  });

  test("a lookup in flight across a write is not cached", async () => {
    const store = createInMemoryTenantRegistryStore();
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const readDone = new Promise((resolve) => {
      entered = resolve;
    });
    let gated = true;
    const registry = createTenantRegistryService({
      cacheTtlMs: 60_000,
      store: {
        ...store,
        async getWorkspace(workspaceId) {
          const answer = await store.getWorkspace(workspaceId);

          if (gated) {
            gated = false;
            entered();
            await gate;
          }

          return answer;
        },
      },
    });

    const pending = registry.lookupWorkspace("ws-a");
    // The store has answered (nothing registered yet) and the lookup has not
    // settled when the workspace is registered.
    await readDone;
    await registry.createWorkspace({ workspaceId: "ws-a" });
    release();
    assert.equal(await pending, null, "the read started before the write");
    assert.deepEqual(await registry.lookupWorkspace("ws-a"), { status: "active", workspaceId: "ws-a" });
  });

  test("TENANT_REGISTRY_CACHE_TTL_MS=0 turns the cache off; errors are never cached", async () => {
    const { counts, store } = countingStore();
    const registry = createTenantRegistryService({ cacheTtlMs: 0, store });

    await registry.lookupWorkspace("ws-a");
    await registry.lookupWorkspace("ws-a");
    assert.equal(counts.getWorkspace, 2);

    let failures = 1;
    const flaky = createTenantRegistryService({
      cacheTtlMs: 60_000,
      store: {
        ...createInMemoryTenantRegistryStore(),
        async getWorkspace() {
          if (failures > 0) {
            failures -= 1;
            throw new Error("connection reset");
          }

          return null;
        },
      },
    });

    await assert.rejects(flaky.lookupWorkspace("ws-a"), /connection reset/);
    assert.equal(await flaky.lookupWorkspace("ws-a"), null);

    await withEnv({ TENANT_REGISTRY_CACHE_TTL_MS: undefined }, () => {
      assert.equal(getTenantRegistryCacheTtlMs(), 5000);
    });
    await withEnv({ TENANT_REGISTRY_CACHE_TTL_MS: "0" }, () => {
      assert.equal(getTenantRegistryCacheTtlMs(), 0);
    });
    await withEnv({ TENANT_REGISTRY_CACHE_TTL_MS: " " }, () => {
      assert.equal(getTenantRegistryCacheTtlMs(), 5000);
    });
  });

  test("each lookup binds the tenant it checks, whatever context it is called from", async () => {
    const { contexts, store } = countingStore();
    const registry = createTenantRegistryService({ cacheTtlMs: 0, store });

    await registry.lookupWorkspace("ws-a");
    await registry.lookupMembership("ws-a", "alice");

    assert.deepEqual(contexts, [
      { call: "getWorkspace", context: "tenant", tenant: { userId: "", workspaceId: "ws-a" } },
      { call: "getMember", context: "tenant", tenant: { userId: "alice", workspaceId: "ws-a" } },
    ]);
  });
});

describe("the PostgreSQL store", () => {
  const squash = (sql) => sql.replace(/\s+/g, " ").trim();

  const recordingQuery = (answers = []) => {
    const calls = [];
    const query = async (text, values) => {
      calls.push({ text: squash(text), values });
      const answer = answers.shift();

      if (answer instanceof Error) {
        throw answer;
      }

      return answer ?? { rowCount: 0, rows: [] };
    };

    return { calls, query };
  };

  const createStore = (answers) => {
    const recorder = recordingQuery(answers);
    let migrations = 0;
    const store = createPostgresTenantRegistryStore({
      query: recorder.query,
      runMigrations: async () => {
        migrations += 1;
      },
      tableNames: { workspaceMembersTable: "t_members", workspacesTable: "t_workspaces" },
    });

    return { ...recorder, migrations: () => migrations, store };
  };

  const workspaceRow = {
    created_at: new Date("2026-10-17T10:00:00.000Z"),
    plan: "team",
    region: "",
    retention_policy: { days: 30 },
    status: "active",
    updated_at: new Date("2026-10-17T10:00:01.000Z"),
    workspace_id: "ws-a",
  };

  test("reads and writes the configured tables with bound values only, migrating once", async () => {
    const { calls, migrations, store } = createStore([
      { rows: [workspaceRow] },
      { rows: [workspaceRow] },
      { rows: [] },
    ]);

    assert.deepEqual(await store.getWorkspace("ws-a"), {
      workspaceId: "ws-a",
      status: "active",
      plan: "team",
      region: "",
      retentionPolicy: { days: 30 },
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:01.000Z",
    });
    assert.equal(
      (await store.insertWorkspace({
        plan: "team",
        region: "",
        retentionPolicy: { days: 30 },
        status: "active",
        workspaceId: "ws-a'; DROP TABLE x; --",
      })).workspaceId,
      "ws-a"
    );
    assert.equal(
      await store.insertWorkspace({ plan: "", region: "", retentionPolicy: {}, status: "active", workspaceId: "ws-a" }),
      null,
      "an existing id inserts nothing"
    );
    assert.equal(migrations(), 1);
    assert.equal(
      calls[0].text,
      "SELECT workspace_id, status, plan, region, retention_policy, created_at, updated_at FROM t_workspaces WHERE workspace_id = $1"
    );
    assert.deepEqual(calls[0].values, ["ws-a"]);
    assert.match(calls[1].text, /^INSERT INTO t_workspaces \(workspace_id, status, plan, region, retention_policy\) VALUES \(\$1, \$2, \$3, \$4, \$5::jsonb\) ON CONFLICT \(workspace_id\) DO NOTHING RETURNING/);
    assert.deepEqual(calls[1].values, ["ws-a'; DROP TABLE x; --", "active", "team", "", '{"days":30}']);
    assert.ok(calls.every((call) => !call.text.includes("DROP TABLE")), "values never reach the SQL text");
  });

  test("a status change reports updated, refused (deleting) or missing", async () => {
    const updated = createStore([{ rows: [{ ...workspaceRow, status: "suspended" }] }]);

    assert.equal(
      (await updated.store.updateWorkspaceStatus({ refuseFrom: ["deleting"], status: "suspended", workspaceId: "ws-a" }))
        .outcome,
      "updated"
    );
    assert.match(updated.calls[0].text, /UPDATE t_workspaces SET status = \$2, updated_at = NOW\(\) WHERE workspace_id = \$1 AND NOT \(status = ANY\(\$3::text\[\]\)\)/);
    assert.deepEqual(updated.calls[0].values, ["ws-a", "suspended", ["deleting"]]);

    const refused = createStore([{ rows: [] }, { rows: [{ ...workspaceRow, status: "deleting" }] }]);
    const refusal = await refused.store.updateWorkspaceStatus({
      refuseFrom: ["deleting"],
      status: "active",
      workspaceId: "ws-a",
    });
    assert.equal(refusal.outcome, "refused");
    assert.equal(refusal.workspace.status, "deleting");

    const missing = createStore([{ rows: [] }, { rows: [] }]);
    assert.deepEqual(
      await missing.store.updateWorkspaceStatus({ refuseFrom: [], status: "active", workspaceId: "ws-x" }),
      { outcome: "missing", workspace: null }
    );
  });

  test("members: upsert reports whether it inserted, a missing workspace is null, delete counts rows", async () => {
    const memberRow = {
      created_at: new Date("2026-10-17T10:00:00.000Z"),
      inserted: true,
      roles: ["workspace.admin"],
      user_id: "alice",
      workspace_id: "ws-a",
    };
    const foreignKey = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
    const { calls, store } = createStore([
      { rows: [memberRow] },
      { rows: [{ ...memberRow, inserted: false }] },
      foreignKey,
      { rowCount: 1, rows: [] },
      { rowCount: 0, rows: [] },
      { rows: [memberRow] },
    ]);

    assert.deepEqual(await store.upsertMember({ roles: ["workspace.admin"], userId: "alice", workspaceId: "ws-a" }), {
      created: true,
      member: {
        workspaceId: "ws-a",
        userId: "alice",
        roles: ["workspace.admin"],
        createdAt: "2026-10-17T10:00:00.000Z",
      },
    });
    assert.equal((await store.upsertMember({ roles: [], userId: "alice", workspaceId: "ws-a" })).created, false);
    assert.equal(await store.upsertMember({ roles: [], userId: "alice", workspaceId: "ws-gone" }), null);
    assert.equal(await store.deleteMember({ userId: "alice", workspaceId: "ws-a" }), true);
    assert.equal(await store.deleteMember({ userId: "alice", workspaceId: "ws-a" }), false);
    assert.equal((await store.listMembers({ limit: 10, offset: 0, workspaceId: "ws-a" })).length, 1);

    assert.match(calls[0].text, /^INSERT INTO t_members \(workspace_id, user_id, roles\) VALUES \(\$1, \$2, \$3::text\[\]\) ON CONFLICT \(workspace_id, user_id\) DO UPDATE SET roles = EXCLUDED.roles RETURNING workspace_id, user_id, roles, created_at, \(xmax = 0\) AS inserted$/);
    assert.deepEqual(calls[0].values, ["ws-a", "alice", ["workspace.admin"]]);
    assert.equal(calls[3].text, "DELETE FROM t_members WHERE workspace_id = $1 AND user_id = $2");
    assert.match(calls[5].text, /FROM t_members WHERE workspace_id = \$1 ORDER BY user_id COLLATE "C" LIMIT \$2 OFFSET \$3/);
    assert.deepEqual(calls[5].values, ["ws-a", 10, 0]);

    const other = Object.assign(new Error("connection reset"), { code: "08006" });
    const failing = createStore([other]);
    await assert.rejects(failing.store.upsertMember({ roles: [], userId: "u", workspaceId: "ws-a" }), /connection reset/);
  });
});

describe("the enforcement decision", () => {
  const seededRegistry = async () => {
    const registry = createMemoryRegistry();

    await registry.createWorkspace({ workspaceId: "ws-a" });
    await registry.createWorkspace({ status: "suspended", workspaceId: "ws-s" });
    await registry.createWorkspace({ workspaceId: "ws-d" });
    await registry.putMember({ roles: ["workspace.viewer"], userId: "alice", workspaceId: "ws-a" });
    await registry.putMember({ roles: ["workspace.admin"], userId: "alice", workspaceId: "ws-s" });
    await registry.putMember({ userId: "alice", workspaceId: "ws-d" });
    await registry.setWorkspaceStatus("ws-d", "deleting");

    return registry;
  };

  test("a user needs a membership of an active workspace; the roles come with it", async () => {
    const registry = await seededRegistry();
    const decide = (workspaceId, userId, workspaceBoundByPrincipal = false) =>
      decideTenantMembership({ registry, userId, workspaceBoundByPrincipal, workspaceId });

    assert.deepEqual(await decide("ws-a", "alice"), { allowed: true, roles: ["workspace.viewer"] });
    assert.equal((await decide("ws-s", "alice")).code, TENANT_MEMBERSHIP_CODES.workspaceSuspended);
    assert.equal((await decide("ws-d", "alice")).code, TENANT_MEMBERSHIP_CODES.workspaceDeleting);

    // A non-member gets the same answer whether the workspace exists, is
    // suspended or not.
    for (const workspaceId of ["ws-a", "ws-s", "ws-missing"]) {
      const decision = await decide(workspaceId, "bob", true);

      assert.deepEqual(decision, {
        allowed: false,
        code: TENANT_MEMBERSHIP_CODES.membershipRequired,
        message: "This credential is not a member of the requested workspace.",
        status: 403,
      });
    }
  });

  test("without a user, only a workspace bound to the principal is checked, for registration and status", async () => {
    const registry = await seededRegistry();
    const decide = (workspaceId, workspaceBoundByPrincipal) =>
      decideTenantMembership({ registry, userId: "", workspaceBoundByPrincipal, workspaceId });

    assert.deepEqual(await decide("ws-a", true), { allowed: true, roles: [] });
    assert.equal((await decide("ws-missing", true)).code, TENANT_MEMBERSHIP_CODES.notRegistered);
    assert.equal((await decide("ws-s", true)).code, TENANT_MEMBERSHIP_CODES.workspaceSuspended);
    // A workspace the client chose by header, with nothing tying the
    // credential to it, is refused even when it is registered and active.
    assert.equal((await decide("ws-a", false)).code, TENANT_MEMBERSHIP_CODES.membershipRequired);
  });

  test("a registry that cannot answer refuses with 503", async () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const decision = await decideTenantMembership({
        registry: {
          lookupMembership: async () => {
            throw new Error("database unreachable");
          },
          lookupWorkspace: async () => null,
        },
        userId: "alice",
        workspaceId: "ws-a",
      });

      assert.deepEqual(decision, {
        allowed: false,
        code: TENANT_MEMBERSHIP_CODES.registryUnavailable,
        message: "The tenant registry is unavailable; try again shortly.",
        status: 503,
      });
    } finally {
      console.error = originalError;
    }
  });

  test("membership roles are merged into the scope's workspace roles for that workspace only", () => {
    const scope = {
      authenticated: true,
      userId: "alice",
      workspaceId: "ws-a",
      workspaceRoles: { "ws-a": ["workspace.viewer"], "ws-b": ["workspace.admin"] },
    };

    assert.deepEqual(mergeMembershipRoles(scope, "ws-a", ["workspace.member", "workspace.viewer"]).workspaceRoles, {
      "ws-a": ["workspace.viewer", "workspace.member"],
      "ws-b": ["workspace.admin"],
    });
    assert.equal(mergeMembershipRoles(scope, "ws-a", []), scope, "no roles: the scope as it was");
    assert.deepEqual(scope.workspaceRoles["ws-a"], ["workspace.viewer"], "the input is not changed");

    // A workspace named like a prototype member stays plain data.
    const merged = mergeMembershipRoles({ workspaceId: "__proto__" }, "__proto__", ["workspace.admin"]);
    assert.deepEqual(Object.getOwnPropertyNames(merged.workspaceRoles), ["__proto__"]);
    assert.equal(Object.getPrototypeOf(merged.workspaceRoles), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(merged.workspaceRoles, "__proto__").value, ["workspace.admin"]);
  });

  test("a merged scope never carries more workspace roles than the split edge can sign", () => {
    // One bound for the registry, the merged scope and the internal token.
    assert.equal(MAX_SCOPE_WORKSPACE_ROLES, MAX_FORWARDED_WORKSPACE_ROLES);
    assert.equal(MAX_MEMBER_ROLES, MAX_FORWARDED_WORKSPACE_ROLES);

    const memberRoles = Array.from({ length: MAX_MEMBER_ROLES }, (_, index) => `custom.r${index}`);
    const scope = (tokenRoles) => ({
      authenticated: true,
      userId: "rita",
      workspaceId: "ws-a",
      ...(tokenRoles ? { workspaceRoles: { "ws-a": tokenRoles, "ws-b": ["custom.other"] } } : {}),
    });
    const allowed = { allowed: true, roles: memberRoles };

    // The membership alone, or with token roles it already holds: allowed,
    // and the edge can sign the result.
    for (const tokenRoles of [null, ["custom.r0"], ["CUSTOM.R1", "custom.r2"]]) {
      const decision = resolveMembershipScope(scope(tokenRoles), "ws-a", allowed);

      assert.equal(decision.allowed, true, JSON.stringify(tokenRoles));
      // Counted as the edge counts them (ids lower-cased, deduplicated).
      assert.equal(
        normalizeServiceAccessScope(decision.accessScope).workspaceRoles["ws-a"].length,
        MAX_MEMBER_ROLES
      );
    }

    // One more distinct role from the token: the unbounded merge is what the
    // edge refused (a RangeError, answered 502 for every forwarded request);
    // now the request is refused up front, with a code, in every topology.
    const overflowing = scope(["custom.extra"]);

    assert.throws(
      () => normalizeServiceAccessScope(mergeMembershipRoles(overflowing, "ws-a", memberRoles)),
      RangeError
    );
    assert.deepEqual(resolveMembershipScope(overflowing, "ws-a", allowed), {
      allowed: false,
      code: TENANT_MEMBERSHIP_CODES.rolesLimitExceeded,
      message: `This credential and its workspace membership grant more than ${MAX_SCOPE_WORKSPACE_ROLES} roles in the workspace; remove some from the membership or the credential.`,
      status: 403,
    });

    // A refusal passes through; a membership without roles leaves the scope
    // as it was (a token's own roles are not this check's business).
    const refused = { allowed: false, code: TENANT_MEMBERSHIP_CODES.membershipRequired, status: 403 };

    assert.equal(resolveMembershipScope(overflowing, "ws-a", refused), refused);

    const tokenOnly = scope(Array.from({ length: 40 }, (_, index) => `custom.t${index}`));

    assert.equal(resolveMembershipScope(tokenOnly, "ws-a", { allowed: true, roles: [] }).accessScope, tokenOnly);
  });
});

describe("migration 036", () => {
  const tableNames = () => ({
    adminAuditEventsTable: "rag_admin_audit_events",
    agentRunEventsTable: "rag_agent_run_events",
    agentRunsTable: "rag_agent_runs",
    documentsTable: "rag_documents",
    longMemoryTable: "long_memory_items",
    sessionMemoryTable: "rag_session_memory",
    taskEventsTable: "rag_task_events",
    tasksTable: "rag_tasks",
    workspaceArtifactsTable: "rag_workspace_artifacts",
  });
  const render = async (names = tableNames()) =>
    renderMigrationSql(
      await readFile(path.join(__dirname, "..", "db", "migrations", "036_create_tenant_registry.sql"), "utf8"),
      names,
      { embeddingDimensions: 8, systemRole: "sys_role", tenantRole: "tenant_role", vectorIndexStatement: "" }
    ).replace(/--[^\n]*/g, "");
  const compact = (sql) => sql.replace(/\s+/g, " ");

  test("it creates both tables, read-only for the tenant role, with full DML for the system role", async () => {
    const sql = compact(await render());

    assert.doesNotMatch(sql, /__[A-Z_]+__/, "every placeholder is rendered");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_workspaces \( workspace_id TEXT PRIMARY KEY CHECK \(workspace_id <> ''\), status TEXT NOT NULL DEFAULT 'active' CHECK \(status IN \('active', 'suspended', 'deleting'\)\),/);
    assert.match(sql, /retention_policy JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_workspace_members \( workspace_id TEXT NOT NULL REFERENCES rag_workspaces \(workspace_id\) ON DELETE CASCADE, user_id TEXT NOT NULL CHECK \(user_id <> ''\), roles TEXT\[\] NOT NULL DEFAULT '\{\}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\), PRIMARY KEY \(workspace_id, user_id\) \);/);
    assert.match(sql, /GRANT SELECT ON rag_workspaces, rag_workspace_members TO tenant_role;/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON rag_workspaces, rag_workspace_members TO sys_role;/);
    assert.doesNotMatch(sql, /GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]* TO tenant_role/, "the tenant role writes nothing");
    assert.doesNotMatch(sql, /PUBLIC/);
  });

  test("its policies: a workspace row as that workspace, a membership row as that user; system_access for the system role", async () => {
    const sql = compact(await render());

    for (const table of ["rag_workspaces", "rag_workspace_members"]) {
      assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
      assert.match(
        sql,
        new RegExp(`CREATE POLICY system_access ON ${table} TO sys_role USING \\(true\\) WITH CHECK \\(true\\);`)
      );
    }

    assert.match(
      sql,
      /CREATE POLICY tenant_isolation ON rag_workspaces FOR SELECT TO tenant_role USING \( workspace_id <> '' AND workspace_id = current_setting\('archive_rag\.workspace_id', true\) \);/
    );
    assert.match(
      sql,
      /CREATE POLICY tenant_isolation ON rag_workspace_members FOR SELECT TO tenant_role USING \( user_id <> '' AND user_id = current_setting\('archive_rag\.user_id', true\) AND \( workspace_id = current_setting\('archive_rag\.workspace_id', true\) OR COALESCE\(current_setting\('archive_rag\.workspace_id', true\), ''\) = '' \) \);/
    );
  });

  test("the table names follow WORKSPACES_POSTGRES_TABLE / WORKSPACE_MEMBERS_POSTGRES_TABLE and are validated", async () => {
    const renamed = await render({ ...tableNames(), workspaceMembersTable: "t_members", workspacesTable: "t_ws" });

    assert.match(renamed, /CREATE TABLE IF NOT EXISTS t_ws \(/);
    assert.match(renamed, /REFERENCES t_ws \(workspace_id\)/);
    assert.match(renamed, /CREATE INDEX IF NOT EXISTS t_members_user_idx/);
    assert.doesNotMatch(renamed, /rag_workspace/);

    await withEnv({ WORKSPACES_POSTGRES_TABLE: "env_ws", WORKSPACE_MEMBERS_POSTGRES_TABLE: "env_members" }, async () => {
      assert.deepEqual(getTenantRegistryTableNames(), { workspaceMembersTable: "env_members", workspacesTable: "env_ws" });
      assert.match(await render(), /CREATE TABLE IF NOT EXISTS env_ws \(/);
    });
    await assert.rejects(render({ ...tableNames(), workspacesTable: "ws; DROP TABLE x" }), /WORKSPACES_POSTGRES_TABLE must be a simple PostgreSQL identifier/);
    await assert.rejects(render({ ...tableNames(), workspaceMembersTable: `m${"x".repeat(54)}` }), /derived tenant registry identifier must be at most 63 bytes/);
    await assert.rejects(
      render({ ...tableNames(), workspaceMembersTable: "same", workspacesTable: "same" }),
      /must differ/
    );
  });
});

describe("TENANT_MEMBERSHIP", () => {
  test("off by default and for blank values; enforce in any case; anything else refuses", async () => {
    for (const value of [undefined, "", "  ", "\t"]) {
      await withEnv({ TENANT_MEMBERSHIP: value }, () => assert.equal(getTenantMembershipMode(), "off"));
    }

    for (const value of ["off", " OFF "]) {
      await withEnv({ TENANT_MEMBERSHIP: value }, () => assert.equal(getTenantMembershipMode(), "off"));
    }

    for (const value of ["enforce", " Enforce "]) {
      await withEnv({ TENANT_MEMBERSHIP: value }, () => assert.equal(getTenantMembershipMode(), "enforce"));
    }

    for (const value of ["on", "true", "strict", "enforcing"]) {
      await withEnv({ TENANT_MEMBERSHIP: value }, () =>
        assert.throws(getTenantMembershipMode, (error) => {
          assert.equal(error.code, "TENANT_MEMBERSHIP_MODE_INVALID");
          assert.match(error.message, /TENANT_MEMBERSHIP must be one of off, enforce/);
          return true;
        })
      );
    }
  });
});

describe("npm run tenant:registry", () => {
  test("parses commands, their arguments and their options strictly", () => {
    assert.deepEqual(parseTenantRegistryArgs(["create", "ws-a", "--plan", "team", "--region=eu"]), {
      args: { workspaceId: "ws-a" },
      command: "create",
      help: false,
      json: false,
      values: { plan: "team", region: "eu" },
    });
    assert.equal(parseTenantRegistryArgs(["--help"]).help, true);
    assert.throws(() => parseTenantRegistryArgs([]), /A command is required/);
    assert.throws(() => parseTenantRegistryArgs(["drop", "ws-a"]), /Unknown command: drop/);
    assert.throws(() => parseTenantRegistryArgs(["suspend"]), /suspend takes <workspaceId>/);
    assert.throws(() => parseTenantRegistryArgs(["add-member", "ws-a"]), /takes <workspaceId> <userId>/);
    assert.throws(() => parseTenantRegistryArgs(["suspend", "ws-a", "--roles", "x"]), /--roles does not apply to suspend/);
    assert.throws(() => parseTenantRegistryArgs(["list", "--force"]), /Unknown option: --force/);
    assert.throws(() => parseTenantRegistryArgs(["list", "--limit"]), /--limit needs a value/);
  });

  test("runs every command on the system path and refuses without PostgreSQL", async () => {
    const registry = createMemoryRegistry({ cacheTtlMs: 0 });
    const contexts = [];
    const watched = new Proxy(registry, {
      get(target, property) {
        const value = target[property];

        return typeof value === "function"
          ? (...args) => {
              contexts.push(getDatabaseTenantContext());
              return value.apply(target, args);
            }
          : value;
      },
    });
    const output = [];
    const run = (argv) =>
      runTenantRegistryCommand(argv, {
        createRegistry: () => watched,
        isConfigured: () => true,
        write: (text) => output.push(text),
      });

    assert.equal((await run(["create", "ws-a", "--plan", "team", "--retention-policy", '{"agentRuns":30}'])).workspace.plan, "team");
    assert.equal((await run(["add-member", "ws-a", "alice", "--roles", "workspace.admin, workspace.viewer"])).created, true);
    assert.deepEqual((await run(["members", "ws-a", "--json"])).members.map((member) => member.roles), [
      ["workspace.admin", "workspace.viewer"],
    ]);
    assert.equal((await run(["suspend", "ws-a"])).workspace.status, "suspended");
    assert.equal((await run(["list", "--status", "suspended"])).workspaces.length, 1);
    assert.equal((await run(["activate", "ws-a"])).workspace.status, "active");
    assert.deepEqual(await run(["remove-member", "ws-a", "alice"]), {
      command: "remove-member",
      removed: true,
      userId: "alice",
      workspaceId: "ws-a",
    });
    await assert.rejects(run(["create", "WS-B"]), /lower case/);
    await assert.rejects(run(["create", "ws-b", "--retention-policy", "{oops"]), /--retention-policy must be a JSON object/);

    assert.ok(contexts.length >= 7);
    assert.deepEqual([...new Set(contexts)], ["system"], "every registry call ran on the system path");
    assert.match(output.join(""), /Registered ws-a\tactive\tplan=team/);
    assert.match(output.join(""), /Added alice in ws-a: workspace.admin,workspace.viewer/);
    assert.ok(JSON.parse(output.find((text) => text.trim().startsWith("{"))).members);

    await assert.rejects(
      runTenantRegistryCommand(["list"], { createRegistry: () => watched, isConfigured: () => false, write: () => {} }),
      /tenant:registry needs PostgreSQL/
    );

    const help = [];
    assert.equal(await runTenantRegistryCommand(["--help"], { isConfigured: () => false, write: (text) => help.push(text) }), null);
    assert.equal(help.join(""), USAGE);
  });
});

// The tenant erase and export (rag/tenant-lifecycle.js) reach the registry
// through these calls: an exact owner match like every other store, the
// memberships before the workspace row, and a mark that stops enforcement
// before anything is deleted.
describe("the registry's tenant records", () => {
  const seeded = async (options = {}) => {
    const registry = createMemoryRegistry(options);

    await registry.createWorkspace({ retentionPolicy: { agentRuns: 7 }, workspaceId: "acme" });
    await registry.createWorkspace({ workspaceId: "globex" });
    await registry.putMember({ roles: ["workspace.admin"], userId: "alice", workspaceId: "acme" });
    await registry.putMember({ userId: "bob", workspaceId: "acme" });
    await registry.putMember({ userId: "alice", workspaceId: "globex" });

    return registry;
  };
  const tablesOf = (entries) => entries.map(({ record, table }) => [table, record.workspaceId, record.userId ?? null]);

  test("a workspace covers its row and every membership; a pair its membership; a user alone nothing", async () => {
    const registry = await seeded();
    const workspace = { userId: null, workspaceId: "acme" };
    const pair = { userId: "alice", workspaceId: "acme" };
    const personal = { userId: "alice", workspaceId: "" };

    assert.deepEqual(tablesOf(await registry.listTenantRecords(workspace)), [
      ["workspace_members", "acme", "alice"],
      ["workspace_members", "acme", "bob"],
      ["workspaces", "acme", null],
    ]);
    assert.deepEqual(tablesOf(await registry.listTenantRecords(pair)), [["workspace_members", "acme", "alice"]]);
    assert.deepEqual(await registry.listTenantRecords(personal), []);
    assert.deepEqual(await registry.countTenantRecords(workspace), {
      workspace_members: { records: 2 },
      workspaces: { records: 1 },
    });
    assert.deepEqual(await registry.countTenantRecords(pair), {
      workspace_members: { records: 1 },
      workspaces: { notApplicable: true, records: 0 },
    });

    assert.deepEqual(await registry.deleteTenantRecords(pair), { workspace_members: { deleted: 1 } });
    assert.equal(await registry.getMember("acme", "alice"), null);
    assert.ok(await registry.getWorkspace("acme"), "a pair erase keeps the workspace");
    assert.ok(await registry.getMember("globex", "alice"), "and the user's other memberships");

    assert.deepEqual(await registry.deleteTenantRecords(workspace), {
      workspace_members: { deleted: 1 },
      workspaces: { deleted: 1 },
    });
    assert.equal(await registry.getWorkspace("acme"), null);
    assert.ok(await registry.getWorkspace("globex"));
  });

  test("marking a workspace deleting refuses its requests at once, from any status, and changes nothing else", async () => {
    const registry = await seeded({ cacheTtlMs: 60_000 });
    const decide = () => decideTenantMembership({ registry, userId: "alice", workspaceId: "acme" });

    // Cached as allowed first: the mark must drop that entry.
    assert.equal((await decide()).allowed, true);
    await registry.suspendWorkspace("globex");
    assert.equal(await registry.markWorkspaceDeleting("acme"), true);
    assert.equal(await registry.markWorkspaceDeleting("globex"), true);
    assert.equal((await decide()).code, TENANT_MEMBERSHIP_CODES.workspaceDeleting);
    assert.equal((await registry.getWorkspace("globex")).status, "deleting");
    // Running it again (a second erase run) is fine.
    assert.equal(await registry.markWorkspaceDeleting("acme"), true);
    // Not registered, or an id the registry cannot hold: nothing to mark.
    assert.equal(await registry.markWorkspaceDeleting("initech"), false);
    assert.equal(await registry.markWorkspaceDeleting("ACME"), false);
    assert.deepEqual((await registry.getWorkspace("acme")).retentionPolicy, { agentRuns: 7 });
    assert.equal((await registry.listMembers("acme")).length, 2);
  });

  test("the PostgreSQL store counts, deletes and lists with exact owner clauses, each page bound to its tenant", async () => {
    const calls = [];
    const query = async (text, values = []) => {
      const sql = text.replace(/\s+/g, " ").trim();

      calls.push({ context: getDatabaseTenantContext(), sql, tenant: getActiveDatabaseTenant(), values });

      if (sql.startsWith("SELECT COUNT")) return { rows: [{ records: 1 }] };
      if (sql.startsWith("DELETE")) return { rowCount: 1 };
      if (sql.startsWith("SELECT DISTINCT")) return { rows: [{ user_id: "alice" }] };
      if (sql.includes("FROM t_members")) {
        return { rows: [{ created_at: new Date(0), roles: ["workspace.admin"], user_id: "alice", workspace_id: "acme" }] };
      }

      return {
        rows: [
          {
            created_at: new Date(0),
            plan: "",
            region: "",
            retention_policy: { agentRuns: 7 },
            status: "deleting",
            updated_at: new Date(0),
            workspace_id: "acme",
          },
        ],
      };
    };
    const store = createPostgresTenantRegistryStore({
      query,
      runMigrations: async () => {},
      tableNames: { workspaceMembersTable: "t_members", workspacesTable: "t_workspaces" },
    });
    const workspace = { userId: null, workspaceId: "acme" };
    const pair = { userId: "alice", workspaceId: "acme" };

    assert.deepEqual(await store.countTenantRecords(pair), {
      workspace_members: { records: 1 },
      workspaces: { notApplicable: true, records: 0 },
    });
    assert.deepEqual(calls.map(({ sql, values }) => [sql, values]), [
      ["SELECT COUNT(*)::int AS records FROM t_members WHERE workspace_id = $1 AND user_id = $2", ["acme", "alice"]],
    ]);

    calls.length = 0;
    assert.deepEqual(await store.deleteTenantRecords(workspace), {
      workspace_members: { deleted: 1 },
      workspaces: { deleted: 1 },
    });
    assert.deepEqual(
      calls.map(({ sql }) => sql),
      ["DELETE FROM t_members WHERE workspace_id = $1", "DELETE FROM t_workspaces WHERE workspace_id = $1"],
      "the memberships first, the workspace row last"
    );

    calls.length = 0;
    const listed = [];

    for await (const entry of store.iterateTenantRecords(workspace)) listed.push(entry);

    assert.deepEqual(
      listed.map(({ record, table }) => [table, record.workspaceId, record.userId ?? null]),
      [
        ["workspace_members", "acme", "alice"],
        ["workspaces", "acme", null],
      ]
    );
    const pages = calls.filter(({ sql }) => sql.startsWith("SELECT *"));

    assert.deepEqual(
      pages.map(({ tenant }) => tenant),
      [
        { userId: "alice", workspaceId: "acme" },
        { userId: "", workspaceId: "acme" },
      ],
      "a membership page as its user in the workspace, the workspace row as the workspace"
    );
    assert.match(pages[1].sql, /^SELECT \* FROM t_workspaces WHERE workspace_id = \$1 ORDER BY workspace_id LIMIT \$2$/);
  });
});
