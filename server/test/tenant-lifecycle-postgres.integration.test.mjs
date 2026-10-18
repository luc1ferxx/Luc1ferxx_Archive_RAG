import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// The tenant erase and export (rag/tenant-lifecycle.js) on a real PostgreSQL:
//
// * the erase removes the tenant's chunks from EVERY chunk table that still
//   exists -- the active migration-012 table and an index version that is no
//   longer a write target (status failed) but keeps its table -- and the
//   tenant's rows in every tenant table (documents, ingest jobs, tasks and
//   task events, runs, run events, artifacts, feedback, session and long-term
//   memory), while another tenant's rows and chunks stay;
// * it keeps the audit log and adds one tombstone whose `details` column
//   (migration 038) holds the ids and counts only;
// * a workspace erase marks the tenant registry's workspace deleting before
//   any data store is erased and removes its usage ledger rows, memberships
//   and row (migrations 036 and 037);
// * the export reads under the tenant's row-level security and never returns
//   the other tenant's rows.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. Like the index versions suite it
// provisions its own database owned by a non-superuser login (the active
// index pointer is global state) and drops everything after.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

const MODEL_A = "tenant-lifecycle-embed-a";
const MODEL_B = "tenant-lifecycle-embed-b";
const TOPICS = ["alpha", "beta", "gamma", "delta"];
const DIMENSIONS = { [MODEL_A]: TOPICS.length + 1, [MODEL_B]: 3 };
const ALICE = Object.freeze({ userId: "alice", workspaceId: "ws-a" });
const BOB = Object.freeze({ userId: "bob", workspaceId: "ws-b" });

const embedFor = (text, model = MODEL_A) => {
  const lower = String(text).toLowerCase();
  const hits = TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0));

  return model === MODEL_B ? [hits[0] + hits[2], hits[1] + hits[3], 0.1] : [...hits, 0.05];
};

const embeddingProvider = {
  completeText: async () => "unused [Source 1]",
  embedQuery: async (query, options) => embedFor(query, options?.embeddingSpace?.model ?? MODEL_A),
  embedTexts: async (texts, options) =>
    texts.map((text) => embedFor(text, options?.embeddingSpace?.model ?? MODEL_A)),
};

if (!adminDatabaseUrl) {
  test("tenant erase and export PostgreSQL integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `tenant_erase_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `tenant_erase_it_tenant_${suffix}`;
  const systemRole = `tenant_erase_it_system_${suffix}`;
  const databaseName = `tenant_erase_it_${suffix}`;
  const withDatabase = (url, name, { password, user } = {}) => {
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
  let tempRoot;
  let service;

  const q = (sql, values = []) => modules.postgres.queryPostgres(sql, values);
  const countFor = async (table, column, tenant) =>
    Number(
      (
        await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1 AND workspace_id = $2`, [
          tenant.userId,
          tenant.workspaceId,
        ])
      ).rows[0].n
    );
  const chunkCountFor = async (table, tenant) =>
    Number(
      (
        await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE owner_user_id = $1 AND workspace_id = $2`, [
          tenant.userId,
          tenant.workspaceId,
        ])
      ).rows[0].n
    );
  const TENANT_TABLES = [
    ["rag_documents", "owner_user_id"],
    ["rag_ingest_jobs", "owner_user_id"],
    ["rag_tasks", "user_id"],
    ["rag_task_events", "user_id"],
    ["rag_agent_runs", "user_id"],
    ["rag_agent_run_events", "user_id"],
    ["rag_workspace_artifacts", "owner_user_id"],
    ["rag_feedback", "owner_user_id"],
    ["rag_session_memory", "owner_user_id"],
  ];
  const tenantRowCounts = async (tenant) => {
    const counts = {};

    for (const [table, column] of TENANT_TABLES) {
      counts[table] = await countFor(table, column, tenant);
    }

    counts.long_memory_items = Number(
      (await q(`SELECT COUNT(*)::int AS n FROM long_memory_items WHERE user_id = $1`, [tenant.userId])).rows[0].n
    );
    counts.rag_document_chunks = await chunkCountFor("rag_document_chunks", tenant);
    counts.rag_document_chunks_v2 = await chunkCountFor("rag_document_chunks_v2", tenant);
    return counts;
  };

  const seedTenant = async (tenant, topic) => {
    const filePath = path.join(tempRoot, `${tenant.userId}.pdf`);

    await writeFile(filePath, buildTextPdf({ pages: [[`The ${topic} policy needs manager approval.`]] }));
    await modules.tenant.runWithDatabaseTenant(tenant, () =>
      modules.rag.ingestDocument({
        docId: `doc-${tenant.userId}`,
        fileName: `${topic}.pdf`,
        filePath,
        ownerUserId: tenant.userId,
        workspaceId: tenant.workspaceId,
      })
    );
    await modules.tenant.runWithDatabaseTenant(tenant, async () => {
      await service.stores.taskStore.upsert({
        accessScope: tenant,
        task: { id: `task-${tenant.userId}`, label: topic, status: "waiting_for_user", type: "external_recommendation" },
      });
      await modules.runs
        .createAgentRunService({ agentRunStore: service.stores.agentRunStore })
        .createRun({
          accessScope: tenant,
          goal: `Summarize ${topic}`,
          runId: `run-${tenant.userId}`,
          status: "waiting_for_user",
        });
      await modules.artifacts.createWorkspaceArtifactService({ store: service.stores.workspaceArtifactStore }).createArtifact({
        accessScope: tenant,
        artifact: {
          artifactType: modules.artifacts.ARTIFACT_TYPES.report,
          content: `# ${topic}`,
          fileName: `${tenant.userId}.md`,
          format: "markdown",
          idempotencyKey: `report-${tenant.userId}`,
          mimeType: "text/markdown",
          title: topic,
        },
      });
      await service.stores.feedbackStore.recordFeedback(
        modules.feedback.buildFeedbackRecord({
          accessScope: tenant,
          payload: { answerText: `${topic} answer`, feedbackType: "helpful", question: `About ${topic}?` },
        })
      );
      await modules.memory.recordSessionTurn({
        accessScope: { ...tenant, authenticated: true },
        answer: `${topic} answer`,
        documents: [],
        query: `About ${topic}?`,
        sessionId: "session-1",
      });
      await service.stores.ingestJobStore.enqueue({
        docId: `pending-${tenant.userId}`,
        fileBytes: Buffer.from(`%PDF-1.4 ${topic}`),
        fileName: `${topic}-pending.pdf`,
        ownerUserId: tenant.userId,
        workspaceId: tenant.workspaceId,
      });
      await service.stores.adminAuditService.recordAuthorizationDecision({
        accessScope: tenant,
        decision: { allowed: true, permissionId: "admin.status.read" },
        request: { method: "GET", path: "/admin/status" },
      });
    });
    // Long-term memory is off in this suite; the row stands for one written
    // while it was on, which the erase must reach regardless.
    await q(
      `INSERT INTO long_memory_items (memory_id, user_id, category, text) VALUES ($1, $2, 'note', $3)`,
      [`memory-${tenant.userId}`, tenant.userId, `${topic} preference`]
    );
  };

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-lifecycle-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    Object.assign(process.env, {
      AGENT_RUN_STORE_PROVIDER: "postgres",
      LONG_MEMORY_DATABASE_URL: "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "tenant-lifecycle-it-key",
      OPENAI_EMBEDDING_MODEL: MODEL_A,
      PDF_PARSER: "pdfjs",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, {
        password: ownerPassword,
        user: ownerRole,
      }),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_SYSTEM_ROLE: systemRole,
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
      RAG_DATA_DIRECTORY: tempRoot,
      RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS[MODEL_A]),
      RAG_HYBRID_ENABLED: "true",
      RAG_LONG_MEMORY_ENABLED: "false",
      TASK_STORE_PROVIDER: "postgres",
      VECTOR_STORE_PROVIDER: "pgvector",
      WORKSPACE_ARTIFACT_STORE_PROVIDER: "postgres",
    });

    const [
      config,
      postgres,
      tenant,
      migrations,
      registry,
      rag,
      openai,
      memory,
      vectorStore,
      lifecycle,
      tenantLifecycle,
      runs,
      artifacts,
      feedback,
      taskStores,
      runStores,
      artifactStores,
      ingestJobs,
      auditStores,
    ] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/postgres-tenant.js"),
      import("../rag/db-migrations.js"),
      import("../rag/doc-registry.js"),
      import("../rag/index.js"),
      import("../rag/openai.js"),
      import("../rag/memory.js"),
      import("../rag/vector-store.js"),
      import("../rag/vector-store-pgvector-version-lifecycle.js"),
      import("../rag/tenant-lifecycle.js"),
      import("../rag/agent-runs.js"),
      import("../rag/workspace-artifacts/index.js"),
      import("../feedback.js"),
      import("../rag/task-store.js"),
      import("../rag/agent-run-store.js"),
      import("../rag/workspace-artifacts/store.js"),
      import("../rag/ingest-job-store.js"),
      import("../rag/admin-audit-store.js"),
    ]);

    modules = { artifacts, config, feedback, lifecycle, memory, migrations, openai, postgres, rag, registry, runs, tenant, vectorStore };
    config.configureEmbeddingDimensions(DIMENSIONS[MODEL_A]);
    openai.configureOpenAIProvider(embeddingProvider);
    memory.resetSessionMemory();
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
    await migrations.runPostgresMigrations();
    await registry.initializeDocumentRegistry();

    // The upload sessions on disk, as the app and the CLI pass them; without
    // a store the erase reports that store skipped and ends partial.
    const uploadSessions = await import("../upload-session-store.js");

    uploadSessions.configureUploadSessionDirectory(path.join(tempRoot, "upload-sessions"));

    const stores = {
      adminAuditService: auditStores.createDefaultAdminAuditService(),
      agentRunStore: runStores.createDefaultAgentRunStore(),
      feedbackStore: feedback.getDefaultFeedbackStore(),
      ingestJobStore: ingestJobs.createDefaultIngestJobStore(),
      taskStore: taskStores.createDefaultTaskStore(),
      uploadStore: {
        eraseUploadSessionsForTenant: uploadSessions.eraseUploadSessionsForTenant,
        listUploadSessionsForTenant: uploadSessions.listUploadSessionsForTenant,
      },
      workspaceArtifactStore: artifactStores.createDefaultWorkspaceArtifactStore(),
    };

    service = {
      ...tenantLifecycle.createTenantLifecycleService({ ...stores, uploadsDirectory: tempRoot }),
      stores,
    };

    // Version 2: its own table at its own width, built from the stored bytes.
    // Topic markers with a hyphen, which base64 never holds, so a search
    // through the exported file bytes cannot match them by chance.
    await seedTenant(ALICE, "alpha-zebra");
    await seedTenant(BOB, "beta-quokka");

    const build = await lifecycle.startIndexVersionBuild({
      builderId: "tenant-erase-it",
      space: lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
    });

    assert.equal(build.versionId, 2);
    // A version no write reaches any more but whose table is still there
    // (a failed build, or a retire whose drop has not run): only an erase that
    // walks every existing chunk table finds the tenant's chunks in it.
    await q(`UPDATE rag_index_versions SET status = 'failed' WHERE version_id = 2`);
  });

  after(async () => {
    try {
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      modules?.vectorStore.resetVectorStore();
      await modules?.registry.resetDocumentRegistryStore();
      await modules?.postgres.resetPostgresPool();
    } finally {
      await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${systemRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("the seed wrote both tenants into every table, both chunk tables included", async () => {
    for (const tenant of [ALICE, BOB]) {
      const counts = await tenantRowCounts(tenant);

      for (const [table, count] of Object.entries(counts)) {
        assert.ok(count > 0, `${tenant.userId} has rows in ${table}`);
      }
    }
  });

  test("the export reads under the tenant's row-level security and holds only its rows", async () => {
    const lines = [];

    for await (const line of service.exportTenant({ ...ALICE, actor: { userId: "ops" } })) {
      lines.push(JSON.parse(line));
    }

    const text = JSON.stringify(lines);

    assert.equal(lines[0].type, "header");
    assert.equal(lines.at(-1).type, "summary", text.slice(0, 2000));
    assert.ok(text.includes("alpha-zebra"));
    assert.equal(text.includes("beta-quokka"), false, "no row of the other tenant");
    assert.ok(lines.some((line) => line.table === "documents" && line.record.file_bytes?.base64));
  });

  test("the erase reaches every chunk table, keeps the other tenant, and leaves a tombstone", async () => {
    const auditBefore = Number(
      (await q(`SELECT COUNT(*)::int AS n FROM rag_admin_audit_events WHERE user_id = 'alice'`)).rows[0].n
    );
    const bobBefore = await tenantRowCounts(BOB);
    const dryRun = await service.eraseTenant({ ...ALICE });

    assert.equal(dryRun.status, "dry_run");
    assert.ok(dryRun.stores.find(({ store }) => store === "documents").tables["chunks:rag_document_chunks_v2"].records > 0);
    // The queued ingest job is work in flight.
    assert.deepEqual(dryRun.activeWork, { ingest_jobs: 1 });

    const refused = await service.eraseTenant({ ...ALICE, dryRun: false });

    assert.equal(refused.status, "refused");

    const result = await service.eraseTenant({
      ...ALICE,
      actor: { userId: "ops" },
      dryRun: false,
      force: true,
      permissionId: "admin.tenants.erase",
    });

    assert.equal(result.status, "completed", JSON.stringify(result));

    for (const [table, count] of Object.entries(await tenantRowCounts(ALICE))) {
      assert.equal(count, 0, `alice has no rows left in ${table}`);
    }

    assert.deepEqual(await tenantRowCounts(BOB), bobBefore, "bob is untouched");

    // The audit log kept alice's events and gained one tombstone with ids and
    // counts only.
    assert.equal(
      Number((await q(`SELECT COUNT(*)::int AS n FROM rag_admin_audit_events WHERE user_id = 'alice'`)).rows[0].n),
      auditBefore
    );

    const tombstone = (
      await q(
        `SELECT user_id, workspace_id, event_type, details FROM rag_admin_audit_events
          WHERE event_type = 'admin.tenant.erased'`
      )
    ).rows;

    assert.equal(tombstone.length, 1);
    assert.equal(tombstone[0].user_id, "ops");
    assert.deepEqual(tombstone[0].details.tenant, { userId: "alice", workspaceId: "ws-a" });
    assert.equal(tombstone[0].details.outcome, "completed");
    assert.ok(tombstone[0].details.counts["chunks:rag_document_chunks_v2"] > 0);
    assert.equal(JSON.stringify(tombstone[0]).includes("alpha-zebra"), false);

    // The BM25 statistics of both tables (migration 030: folded totals plus
    // the not yet folded log) no longer count alice's scope.
    for (const base of ["rag_document_chunks", "rag_document_chunks_v2"]) {
      const totals = await q(
        `SELECT
           COALESCE((SELECT SUM(chunk_count) FROM ${base}_sparse_scopes
                      WHERE owner_user_id = 'alice' AND workspace_id = 'ws-a'), 0)
         + COALESCE((SELECT SUM(chunk_delta) FROM ${base}_sparse_scope_log
                      WHERE owner_user_id = 'alice' AND workspace_id = 'ws-a'), 0) AS chunks`
      );

      assert.equal(Number(totals.rows[0].chunks), 0, `${base} statistics`);
    }
  });

  // The registry (migration 036) and the usage ledger (migration 037): a
  // workspace erase marks the workspace deleting before any data store is
  // erased, deletes its usage rows, then its memberships and its row last;
  // the export reads them under each tenant's row-level security.
  test("a workspace erase marks the registry workspace deleting first and removes its usage, memberships and row", async () => {
    const [{ createTenantLifecycleService }, registryModule, usageModule] = await Promise.all([
      import("../rag/tenant-lifecycle.js"),
      import("../rag/tenant-registry.js"),
      import("../rag/tenant-usage.js"),
    ]);
    const CAROL = Object.freeze({ userId: "carol", workspaceId: "ws-c" });
    const DAVE = Object.freeze({ userId: "dave", workspaceId: "ws-c" });
    const registry = registryModule.createTenantRegistryService({
      cacheTtlMs: 0,
      store: registryModule.createPostgresTenantRegistryStore(),
    });
    const ledger = usageModule.createTenantUsageLedger({ clearTimer: () => {}, setTimer: () => ({ unref() {} }) });
    const usageRows = async (workspaceId) =>
      Number((await q(`SELECT COUNT(*)::int AS n FROM tenant_usage WHERE workspace_id = $1`, [workspaceId])).rows[0].n);
    const registryStatus = async () =>
      (await q(`SELECT status FROM rag_workspaces WHERE workspace_id = $1`, [CAROL.workspaceId])).rows[0]?.status ?? null;

    await modules.tenant.runAsDatabaseSystem(async () => {
      await registry.createWorkspace({ retentionPolicy: { agentRuns: 30 }, workspaceId: CAROL.workspaceId });
      await registry.putMember({ roles: ["workspace.admin"], userId: CAROL.userId, workspaceId: CAROL.workspaceId });
      await registry.putMember({ userId: DAVE.userId, workspaceId: DAVE.workspaceId });
      await registry.createWorkspace({ workspaceId: BOB.workspaceId });
      await registry.putMember({ userId: BOB.userId, workspaceId: BOB.workspaceId });
    });
    ledger.record(CAROL, { chat_requests: 2 });
    ledger.record(DAVE, { model_tokens: 40 });
    ledger.record(BOB, { chat_requests: 1 });
    await ledger.flush();
    await modules.tenant.runWithDatabaseTenant(CAROL, () =>
      service.stores.taskStore.upsert({
        accessScope: CAROL,
        task: { id: "task-carol", label: "carol", status: "waiting_for_user", type: "external_recommendation" },
      })
    );

    const bobUsageBefore = await usageRows(BOB.workspaceId);
    const statusWhileErasing = [];
    const taskStore = service.stores.taskStore;
    const eraser = createTenantLifecycleService({
      ...service.stores,
      taskStore: {
        countTenantRecords: (selector) => taskStore.countTenantRecords(selector),
        async deleteTenantRecords(selector) {
          statusWhileErasing.push(await registryStatus());
          return taskStore.deleteTenantRecords(selector);
        },
        iterateTenantRecords: (selector) => taskStore.iterateTenantRecords(selector),
      },
      tenantRegistry: registry,
      tenantUsageStore: usageModule.createTenantUsageRecordStore({ ledger }),
      uploadsDirectory: tempRoot,
    });

    const lines = [];

    for await (const line of eraser.exportTenant({ actor: { userId: "ops" }, workspaceId: CAROL.workspaceId })) {
      lines.push(JSON.parse(line));
    }

    const exported = lines.filter((line) => line.type === "record");

    assert.equal(lines.at(-1).type, "summary", JSON.stringify(lines.at(-1)));
    assert.equal(exported.filter((line) => line.table === "workspaces").length, 1);
    assert.equal(exported.filter((line) => line.table === "workspace_members").length, 2);
    assert.equal(exported.filter((line) => line.table === "tenant_usage").length, 2);
    assert.ok(exported.every((line) => line.record.workspaceId !== BOB.workspaceId), "nothing of ws-b");

    const dryRun = await eraser.eraseTenant({ workspaceId: CAROL.workspaceId });

    assert.equal(dryRun.status, "dry_run");
    assert.equal(await registryStatus(), "active", "a dry run marks nothing");

    const result = await eraser.eraseTenant({
      actor: { userId: "ops" },
      dryRun: false,
      permissionId: "admin.tenants.erase",
      workspaceId: CAROL.workspaceId,
    });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(statusWhileErasing, ["deleting"]);
    assert.equal(result.stores.find(({ store }) => store === "tenant_registry").workspaceStatus, "deleting");
    assert.equal(await registryStatus(), null);
    assert.equal(
      Number(
        (await q(`SELECT COUNT(*)::int AS n FROM rag_workspace_members WHERE workspace_id = $1`, [CAROL.workspaceId]))
          .rows[0].n
      ),
      0
    );
    assert.equal(await usageRows(CAROL.workspaceId), 0);
    assert.equal(await usageRows(BOB.workspaceId), bobUsageBefore, "ws-b's usage stays");
    assert.ok(await modules.tenant.runAsDatabaseSystem(() => registry.getWorkspace(BOB.workspaceId)));

    const tombstone = (
      await q(
        `SELECT details FROM rag_admin_audit_events
          WHERE event_type = 'admin.tenant.erased' AND details->'tenant'->>'workspaceId' = $1`,
        [CAROL.workspaceId]
      )
    ).rows;

    assert.equal(tombstone.length, 1);
    assert.equal(tombstone[0].details.counts.workspaces, 1);
    assert.equal(tombstone[0].details.counts.workspace_members, 2);
    assert.equal(tombstone[0].details.counts.tenant_usage, 2);
  });
}
