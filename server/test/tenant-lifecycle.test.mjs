// Tenant erase and export (rag/tenant-lifecycle.js) over every in-memory and
// file-backed store, and the admin routes (routes/admin-tenant-lifecycle.js).
// The PostgreSQL side (every index version table, the audit tombstone, row-level
// security around the export) is tenant-lifecycle-postgres.integration.test.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";

// The local index and file registry: no database or model (as app.test.mjs).
process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";
for (const key of ["POSTGRES_DATABASE_URL", "LONG_MEMORY_DATABASE_URL", "POSTGRES_MIGRATION_DATABASE_URL"]) {
  delete process.env[key];
}

const { createApp } = await import("../app.js");
const { buildTextPdf } = await import("../evaluation/load-bench-pdf.mjs");
const { buildFeedbackRecord, configureFeedbackDirectory, createFileFeedbackStore } = await import("../feedback.js");
const { createAdminAuditService, createInMemoryAdminAuditStore } = await import("../rag/admin-audit.js");
const { AGENT_RUN_STATUSES, createAgentRunService, createInMemoryAgentRunStore } = await import(
  "../rag/agent-runs.js"
);
const { configureDocumentRegistryStore, listStoredDocumentsForTenant, resetDocumentRegistryStore } =
  await import("../rag/doc-registry.js");
const { createFileDocumentRegistryStore } = await import("../rag/doc-registry-file.js");
const { ingestDocument } = await import("../rag/index.js");
const { createInMemoryIngestJobStore } = await import("../rag/ingest-job-store.js");
const { configureLongMemoryStore } = await import("../rag/long-memory.js");
const { configureSessionMemoryStore, recordSessionTurn, resetSessionMemoryStore } = await import(
  "../rag/memory.js"
);
const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { runWithDatabaseTenant } = await import("../rag/postgres-tenant.js");
const { judgeClaimSupport, resetClaimJudgeCache, eraseClaimJudgeTenantVerdicts } = await import(
  "../rag/self-check/claim-judge.js"
);
const { evaluateClaimSupport } = await import("../rag/self-check/evaluate.js");
const { getSemanticCacheStats, lookupSemanticCache, resetSemanticCache, storeSemanticCacheAnswer } =
  await import("../rag/semantic-cache.js");
const { configureRagDataDirectory, getRagDataDirectory } = await import("../rag/storage.js");
const { createInMemoryTaskStore } = await import("../rag/tasks.js");
const { createInMemoryTenantRegistryStore, createTenantRegistryService, decideTenantMembership } =
  await import("../rag/tenant-registry.js");
const { createTenantUsageLedger, createTenantUsageRecordStore } = await import("../rag/tenant-usage.js");
const { createTenantLifecycleService, TENANT_EXPORT_FORMAT, TENANT_LIFECYCLE_ERROR_CODES } = await import(
  "../rag/tenant-lifecycle.js"
);
const {
  normalizeTenantSelector,
  summarizeTenantRecords,
  tenantSelectorMatches,
  tenantSelectorMatchesUser,
  TENANT_SELECTOR_ERROR_CODE,
} = await import("../rag/tenant-records.js");
const { searchLocalDocuments } = await import("../rag/vector-store-local.js");
const { resetVectorStore } = await import("../rag/vector-store.js");
const { createInMemoryWorkspaceArtifactStore, createWorkspaceArtifactService, ARTIFACT_TYPES } =
  await import("../rag/workspace-artifacts/index.js");
const { createInMemorySessionMemoryStore } = await import("../standalone-profile.js");
const {
  CLI_DOCUMENTS_WITHHELD_HINT,
  createCliTenantLifecycleService,
  describeCliDocumentEraseBlockers,
  parseTenantLifecycleArgs,
  runTenantLifecycleCommand,
} = await import("../tenant-lifecycle.mjs");
const {
  configureUploadSessionDirectory,
  eraseUploadSessionsForTenant,
  initializeUploadSession,
  listUploadSessionsForTenant,
} = await import("../upload-session-store.js");

// A: the tenant erased. B: another tenant. A_ELSEWHERE: A's user in another
// workspace, whose records a pair erase of A leaves alone (long-term memory
// excepted: it belongs to the user in every workspace).
const A = Object.freeze({ userId: "alice", workspaceId: "acme" });
const B = Object.freeze({ userId: "bob", workspaceId: "globex" });
const A_ELSEWHERE = Object.freeze({ userId: "alice", workspaceId: "globex" });
const MARKER_A = "zebracorn";
const MARKER_B = "quokkafish";

const DIMENSIONS = 8;
const embedText = (text) => {
  const vector = new Array(DIMENSIONS).fill(0);

  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 0;

    for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) % DIMENSIONS;
    vector[hash] += 1;
  }

  return vector;
};

// Long-term memory has no production in-memory store (it is PostgreSQL or
// off); this one keeps the tenant record contract, matched on the user alone.
const createLongMemoryStore = () => {
  const memories = [];

  return {
    memories,
    async remember({ text, userId }) {
      memories.push({ memoryId: `memory-${memories.length + 1}`, text, userId });
    },
    async countTenantRecords(selector) {
      return summarizeTenantRecords(await this.listTenantRecords(selector), ["long_memory"]);
    },
    async listTenantRecords(selector) {
      return memories
        .filter((memory) => tenantSelectorMatchesUser(selector, memory.userId))
        .map((memory) => ({ record: { ...memory }, table: "long_memory" }));
    },
    async deleteTenantRecords(selector) {
      const kept = memories.filter((memory) => !tenantSelectorMatchesUser(selector, memory.userId));
      const deleted = memories.length - kept.length;

      memories.splice(0, memories.length, ...kept);
      return { long_memory: { deleted } };
    },
  };
};

// The RAG_SHARED_STATE=redis client, reduced to the calls the claim judge and
// its erase make (MGET, a SET pipeline, SCAN with MATCH, DEL).
const createFakeRedis = () => {
  const values = new Map();
  const toRegExp = (pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

  return {
    values,
    async mget(keys) {
      return keys.map((key) => values.get(key) ?? null);
    },
    pipeline() {
      const writes = [];

      return {
        set(key, value) {
          writes.push([key, value]);
          return this;
        },
        async exec() {
          for (const [key, value] of writes) values.set(key, value);
          return writes.map(() => [null, "OK"]);
        },
      };
    },
    async scan(cursor, _match, pattern) {
      const matcher = toRegExp(pattern);

      return ["0", [...values.keys()].filter((key) => matcher.test(key))];
    },
    async del(...keys) {
      let removed = 0;

      for (const key of keys) removed += values.delete(key) ? 1 : 0;
      return removed;
    },
  };
};

const JUDGE_CITATION = {
  docId: "vendor-a",
  evidenceText:
    "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months preceding the claim.",
  excerpt: "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months",
  fileName: "vendor-a.pdf",
  pageNumber: 2,
};

const judgeAs = (tenant, redis) =>
  judgeClaimSupport({
    accessScope: tenant,
    citations: [JUDGE_CITATION],
    claimSupport: evaluateClaimSupport({
      answerText: "Vendor A's liability is capped at the fees from the previous twelve months. [Source 1]",
      citations: [JUDGE_CITATION],
    }),
    complete: async (prompt) => ({
      modelRoute: { modelId: "judge-model" },
      text: JSON.stringify({
        verdicts: [...prompt.matchAll(/^Claim (\d+) /gm)].map((match) => ({
          claim: Number(match[1]),
          reason: "stated",
          supported: true,
        })),
      }),
    }),
    sharedRedis: redis,
  });

const primeSemanticCache = async (tenant, docId) => {
  const lookup = await lookupSemanticCache({
    accessScope: tenant,
    docIds: [docId],
    query: `What does ${docId} say?`,
    queryVector: [1, 0, 0],
    resolvedQuery: `What does ${docId} say?`,
    routeMode: "qa",
    selectedDocuments: [
      {
        chunkCount: 1,
        contentSha256: `sha-${docId}`,
        docId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        uploadedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      },
    ],
  });

  assert.equal(lookup.hit, false);
  assert.equal(
    storeSemanticCacheAnswer(lookup, { citations: [{ docId, pageNumber: 1 }], text: `${docId} answer [Source 1]` })
      .stored,
    true
  );
};

const ENV_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "RAG_CLAIM_JUDGE",
  "RAG_SEMANTIC_CACHE",
  "RBAC_MODE",
];

const snapshotEnv = () => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  return () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};

const readJsonLines = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const collectLines = async (lines) => {
  const collected = [];

  for await (const line of lines) collected.push(JSON.parse(line));
  return collected;
};

test("a selector names a workspace, a user, or both, and matches owner columns exactly", () => {
  assert.deepEqual(normalizeTenantSelector({ workspaceId: " acme " }), { userId: null, workspaceId: "acme" });
  assert.deepEqual(normalizeTenantSelector({ userId: "ann", workspaceId: "acme" }), {
    userId: "ann",
    workspaceId: "acme",
  });
  assert.deepEqual(normalizeTenantSelector({ userId: "ann" }), { userId: "ann", workspaceId: "" });

  for (const input of [{}, { userId: "", workspaceId: " " }, { userId: 7, workspaceId: "acme" }, {
    workspaceId: "a\u0000b",
  }, { workspaceId: "x".repeat(257) }]) {
    assert.throws(() => normalizeTenantSelector(input), (error) => error.code === TENANT_SELECTOR_ERROR_CODE);
  }

  // Only an absent userId means every user of the workspace. One that is
  // given but empty (an unset variable in a script, "userId": "") is refused
  // instead of widening a one-user erase or export to the whole workspace.
  for (const userId of ["", "   ", "\t"]) {
    assert.throws(
      () => normalizeTenantSelector({ userId, workspaceId: "acme" }),
      (error) =>
        error.code === TENANT_SELECTOR_ERROR_CODE && error.status === 400 && /userId must not be empty/.test(error.message),
      JSON.stringify(userId)
    );
  }

  for (const userId of [null, undefined]) {
    assert.deepEqual(normalizeTenantSelector({ userId, workspaceId: "acme" }), { userId: null, workspaceId: "acme" });
  }

  const workspace = normalizeTenantSelector({ workspaceId: "acme" });
  const pair = normalizeTenantSelector({ userId: "ann", workspaceId: "acme" });
  const personal = normalizeTenantSelector({ userId: "ann" });

  // A workspace selector covers every user of the workspace, the shared rows
  // (no owner) included, and nothing outside it.
  assert.equal(tenantSelectorMatches(workspace, { userId: "ann", workspaceId: "acme" }), true);
  assert.equal(tenantSelectorMatches(workspace, { ownerUserId: "", workspaceId: "acme" }), true);
  assert.equal(tenantSelectorMatches(workspace, { userId: "ann", workspaceId: "" }), false);
  // A pair is exact: not the workspace's shared rows, not the user's personal ones.
  assert.equal(tenantSelectorMatches(pair, { owner_user_id: "ann", workspace_id: "acme" }), true);
  assert.equal(tenantSelectorMatches(pair, { userId: "", workspaceId: "acme" }), false);
  assert.equal(tenantSelectorMatches(pair, { userId: "ann", workspaceId: "" }), false);
  assert.equal(tenantSelectorMatches(personal, { userId: "ann", workspaceId: "" }), true);
  assert.equal(tenantSelectorMatches(personal, { userId: "ann", workspaceId: "acme" }), false);
  // Long-term memory (user only) needs a selector that names the user.
  assert.equal(tenantSelectorMatchesUser(workspace, "ann"), false);
  assert.equal(tenantSelectorMatchesUser(pair, "ann"), true);
});

test("the PostgreSQL record calls: an exact WHERE, children swept again, pages read as each tenant", async () => {
  const { getActiveDatabaseTenant, getDatabaseTenantContext, runAsDatabaseSystem } = await import(
    "../rag/postgres-tenant.js"
  );
  const { createPostgresTenantRecordMethods } = await import("../rag/tenant-records.js");
  const calls = [];
  const rowsByUser = {
    "": [{ id: "1", task_id: "shared", user_id: "", workspace_id: "acme" }],
    ann: [
      { file_bytes: Buffer.from("pdf"), id: "2", task_id: "t-1", user_id: "ann", workspace_id: "acme" },
      { id: "3", task_id: "t-2", user_id: "ann", workspace_id: "acme" },
    ],
  };
  const query = async (sql, values = []) => {
    const text = sql.replace(/\s+/g, " ").trim();

    calls.push({ context: getDatabaseTenantContext(), tenant: getActiveDatabaseTenant(), text, values });

    if (text.startsWith("SELECT COUNT")) return { rows: [{ active: 1, records: 3 }] };
    if (text.startsWith("DELETE")) return { rowCount: 2 };
    if (text.startsWith("SELECT DISTINCT")) return { rows: [{ user_id: "" }, { user_id: "ann" }] };

    // Keyset pages of two rows: the second page starts after the last key.
    const user = values[1];
    const after = values.length === 4 ? values[2] : null;
    const rows = rowsByUser[user].filter((row) => after === null || row.id > after);

    return { rows: rows.slice(0, 2) };
  };
  const methods = createPostgresTenantRecordMethods({
    query,
    tables: () => [
      { keyColumns: ["id"], name: "task_events", pageSize: 2, sweepAfter: true, table: "t_events", userColumn: "user_id" },
      { keyColumns: ["id"], name: "tasks", pageSize: 2, table: "t_tasks", userColumn: "user_id" },
      { keyColumns: ["id"], name: "long_memory", table: "t_memory", userColumn: "user_id", userOnly: true },
    ],
  });
  const workspace = normalizeTenantSelector({ workspaceId: "acme" });
  const pair = normalizeTenantSelector({ userId: "ann", workspaceId: "acme" });

  assert.deepEqual(await runAsDatabaseSystem(() => methods.countTenantRecords(pair)), {
    long_memory: { records: 3 },
    task_events: { records: 3 },
    tasks: { active: 1, records: 3 },
  });
  assert.equal(calls[1].text, "SELECT COUNT(*)::int AS records, COUNT(*) FILTER (WHERE status = ANY($3::text[]))::int AS active FROM t_tasks WHERE workspace_id = $1 AND user_id = $2");
  assert.deepEqual(calls[1].values, ["acme", "ann", ["queued", "running"]]);
  assert.equal(calls[2].text, "SELECT COUNT(*)::int AS records FROM t_memory WHERE user_id = $1");

  // A workspace selector has no user clause and never reaches the user-only table.
  calls.length = 0;
  assert.deepEqual(await runAsDatabaseSystem(() => methods.deleteTenantRecords(workspace)), {
    task_events: { deleted: 4 },
    tasks: { deleted: 2 },
  });
  assert.deepEqual(
    calls.map(({ text }) => text),
    [
      "DELETE FROM t_events WHERE workspace_id = $1",
      "DELETE FROM t_tasks WHERE workspace_id = $1",
      "DELETE FROM t_events WHERE workspace_id = $1",
    ]
  );
  assert.ok(calls.every(({ context }) => context === "system"));

  // Listing: the distinct users as the system, then each pair's pages as that tenant.
  calls.length = 0;
  const listed = [];

  for await (const entry of methods.iterateTenantRecords(workspace)) {
    if (entry.table === "tasks") listed.push(entry);
  }

  assert.deepEqual(
    listed.map(({ record }) => record.task_id),
    ["shared", "t-1", "t-2"]
  );
  assert.deepEqual(listed[1].record.file_bytes, { base64: Buffer.from("pdf").toString("base64") });

  const taskCalls = calls.filter(({ text }) => text.includes("t_tasks"));

  assert.equal(taskCalls[0].context, "system");
  assert.match(taskCalls[0].text, /^SELECT DISTINCT user_id AS user_id FROM t_tasks WHERE workspace_id = \$1/);
  assert.deepEqual(
    taskCalls.slice(1).map(({ tenant, values }) => [tenant, values]),
    [
      [{ userId: "", workspaceId: "acme" }, ["acme", "", 2]],
      [{ userId: "ann", workspaceId: "acme" }, ["acme", "ann", 2]],
      [{ userId: "ann", workspaceId: "acme" }, ["acme", "ann", "3", 2]],
    ]
  );
  assert.match(taskCalls[3].text, /AND \(id\) > \(\$3\) ORDER BY id LIMIT \$4$/);

  // The audit log keeps its rows: a store made with allowDelete: false refuses.
  const keep = createPostgresTenantRecordMethods({ allowDelete: false, query, tables: () => [] });

  await assert.rejects(() => keep.deleteTenantRecords(pair), /kept by a tenant erase/);
});

describe("erase and export over every in-memory store", () => {
  const state = {};

  before(async () => {
    state.restoreEnv = snapshotEnv();
    process.env.RAG_CLAIM_JUDGE = "llm";
    process.env.RAG_SEMANTIC_CACHE = "on";
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-lifecycle-"));
    state.originalRagDataDirectory = getRagDataDirectory();
    state.uploadsDirectory = path.join(state.tempRoot, "uploads");

    configureRagDataDirectory(path.join(state.tempRoot, "rag-data"));
    await resetDocumentRegistryStore();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    resetVectorStore();
    resetSemanticCache();
    resetClaimJudgeCache();
    configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async (query) => embedText(query),
      embedTexts: async (texts) => texts.map(embedText),
    });
    configureUploadSessionDirectory(path.join(state.tempRoot, "upload-sessions"));
    state.sessionStore = createInMemorySessionMemoryStore();
    configureSessionMemoryStore(state.sessionStore);
    state.longMemoryStore = createLongMemoryStore();
    configureLongMemoryStore(state.longMemoryStore);

    state.taskStore = createInMemoryTaskStore();
    state.agentRunStore = createInMemoryAgentRunStore();
    state.artifactStore = createInMemoryWorkspaceArtifactStore();
    state.ingestJobStore = createInMemoryIngestJobStore();
    state.feedbackStore = createFileFeedbackStore({ directory: path.join(state.tempRoot, "feedback") });
    state.adminAuditService = createAdminAuditService({ store: createInMemoryAdminAuditStore() });
    state.redis = createFakeRedis();

    const runService = createAgentRunService({ agentRunStore: state.agentRunStore });
    const artifactService = createWorkspaceArtifactService({ store: state.artifactStore });
    let jobNumber = 0;

    for (const [tenant, marker] of [
      [A, MARKER_A],
      [B, MARKER_B],
      [A_ELSEWHERE, `${MARKER_A}-elsewhere`],
    ]) {
      const key = `${tenant.userId}-${tenant.workspaceId}`;
      const pdfPath = path.join(state.tempRoot, `${key}.pdf`);

      await writeFile(pdfPath, buildTextPdf({ pages: [[`The ${marker} policy needs manager approval.`]] }));
      await ingestDocument({
        docId: `doc-${key}`,
        fileName: `${marker}.pdf`,
        filePath: pdfPath,
        ownerUserId: tenant.userId,
        workspaceId: tenant.workspaceId,
      });

      await state.taskStore.upsert({
        accessScope: tenant,
        task: { id: `task-${key}`, label: marker, status: "waiting_for_user", type: "external_recommendation" },
      });
      await runService.createRun({
        accessScope: tenant,
        goal: `Summarize ${marker}`,
        runId: `run-${key}`,
        status: AGENT_RUN_STATUSES.waitingForUser,
      });
      await artifactService.createArtifact({
        accessScope: tenant,
        artifact: {
          artifactType: ARTIFACT_TYPES.report,
          content: `# ${marker}`,
          fileName: `${key}.md`,
          format: "markdown",
          idempotencyKey: `report-${key}`,
          mimeType: "text/markdown",
          title: marker,
        },
      });
      await state.feedbackStore.recordFeedback(
        buildFeedbackRecord({
          accessScope: tenant,
          payload: { answerText: `${marker} answer`, feedbackType: "helpful", question: `About ${marker}?` },
        })
      );
      await runWithDatabaseTenant(tenant, () =>
        recordSessionTurn({
          accessScope: { ...tenant, authenticated: true },
          answer: `${marker} answer`,
          documents: [],
          query: `About ${marker}?`,
          sessionId: "session-1",
        })
      );
      await state.adminAuditService.recordAuthorizationDecision({
        accessScope: tenant,
        decision: { allowed: true, permissionId: "admin.status.read" },
        request: { method: "GET", path: "/admin/status" },
      });
      await initializeUploadSession({
        accessScope: tenant,
        chunkSize: 16,
        fileId: `upload-${key}`,
        fileName: `${key}.pdf`,
        fileSize: 16,
        totalChunks: 1,
      });

      // A dead-letter job (it keeps its bytes) and its attempt file.
      jobNumber += 1;
      const jobId = `job-${jobNumber}-${key}`;

      await state.ingestJobStore.enqueue({
        docId: `pending-${key}`,
        fileBytes: Buffer.from(`%PDF-1.4 ${marker}`),
        fileName: `${marker}-pending.pdf`,
        jobId,
        maxAttempts: 1,
        ownerUserId: tenant.userId,
        workspaceId: tenant.workspaceId,
      });
      const claimed = await state.ingestJobStore.claim({ leaseMs: 60_000, workerId: "seed-worker" });

      assert.equal(claimed.jobId, jobId);
      await state.ingestJobStore.fail({
        attemptCount: claimed.attemptCount,
        deadLetterReason: "parse_failed",
        error: new Error("parse failed"),
        jobId,
        retryable: true,
        workerId: "seed-worker",
      });
      await mkdir(path.join(state.uploadsDirectory, "ingest-tmp"), { recursive: true });
      await writeFile(
        path.join(
          state.uploadsDirectory,
          "ingest-tmp",
          `ingest-${jobId}-1-00000000-0000-4000-8000-00000000000${jobNumber}.pdf`
        ),
        "x"
      );

      await judgeAs(tenant, state.redis);
      await primeSemanticCache(tenant, `cached-${key}`);
    }

    await state.longMemoryStore.remember({ text: `${MARKER_A} preference`, userId: A.userId });
    await state.longMemoryStore.remember({ text: `${MARKER_B} preference`, userId: B.userId });

    // The tenant registry: A's and B's workspaces with their members (A's
    // user belongs to both).
    state.tenantRegistry = createTenantRegistryService({ store: createInMemoryTenantRegistryStore() });
    await state.tenantRegistry.createWorkspace({ workspaceId: A.workspaceId });
    await state.tenantRegistry.createWorkspace({ workspaceId: B.workspaceId });
    for (const tenant of [A, B, A_ELSEWHERE]) {
      await state.tenantRegistry.putMember({ roles: ["workspace.member"], ...tenant });
    }

    state.service = createTenantLifecycleService({
      adminAuditService: state.adminAuditService,
      agentRunStore: state.agentRunStore,
      claimJudge: {
        erase: (selector, options) =>
          eraseClaimJudgeTenantVerdicts(selector, { ...options, sharedRedis: state.redis }),
      },
      feedbackStore: state.feedbackStore,
      ingestJobStore: state.ingestJobStore,
      taskStore: state.taskStore,
      tenantRegistry: state.tenantRegistry,
      uploadStore: { eraseUploadSessionsForTenant, listUploadSessionsForTenant },
      uploadsDirectory: state.uploadsDirectory,
      workspaceArtifactStore: state.artifactStore,
    });
  });

  after(async () => {
    state.restoreEnv();
    resetOpenAIProvider();
    resetSemanticCache();
    resetClaimJudgeCache();
    configureLongMemoryStore(null);
    await resetSessionMemoryStore();
    await resetDocumentRegistryStore();
    resetVectorStore();
    configureRagDataDirectory(state.originalRagDataDirectory);
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  const tableCounts = (result) =>
    Object.fromEntries(
      result.stores.flatMap(({ tables }) =>
        Object.entries(tables).map(([table, count]) => [table, count])
      )
    );

  const recordsOf = async (selector) => ({
    agentRuns: state.agentRunStore.listTenantRecords(selector).length,
    artifacts: state.artifactStore.listTenantRecords(selector).length,
    claimJudge: (await eraseClaimJudgeTenantVerdicts(selector, { dryRun: true, sharedRedis: state.redis })),
    documents: (await listStoredDocumentsForTenant(selector)).length,
    feedback: (await state.feedbackStore.listTenantRecords(selector)).length,
    ingestJobs: state.ingestJobStore.listTenantRecords(selector).length,
    registry: (await state.tenantRegistry.listTenantRecords(selector)).length,
    sessions: (await state.sessionStore.listTenantRecords(selector)).length,
    tasks: state.taskStore.listTenantRecords(selector).length,
    uploads: (await listUploadSessionsForTenant(selector)).length,
  });

  test("a dry run counts every store and deletes nothing", async () => {
    const before = await recordsOf(normalizeTenantSelector(A));
    const result = await state.service.eraseTenant({ ...A });
    const counts = tableCounts(result);

    assert.equal(result.status, "dry_run");
    assert.equal(result.complete, true, `skipped: ${result.skippedStores.join(", ")}`);
    assert.deepEqual(result.tenant, { userId: "alice", workspaceId: "acme" });
    assert.deepEqual(
      result.stores.map(({ store }) => store),
      [
        "ingest_jobs",
        "upload_sessions",
        "tasks",
        "agent_runs",
        "documents",
        "workspace_artifacts",
        "feedback",
        "session_memory",
        "long_memory",
        "claim_judge_cache",
        "semantic_cache",
        "tenant_usage",
        "tenant_registry",
      ]
    );
    assert.deepEqual(counts.ingest_jobs, { active: 0, records: 1 });
    assert.deepEqual(counts.ingest_temp_files, { records: 1 });
    assert.deepEqual(counts.upload_sessions, { records: 1 });
    assert.deepEqual(counts.tasks, { active: 0, records: 1 });
    assert.deepEqual(counts.agent_runs, { active: 0, records: 1 });
    assert.deepEqual(counts.agent_run_events, { records: 1 });
    assert.deepEqual(counts.documents, { records: 1 });
    assert.deepEqual(counts.workspace_artifacts, { records: 1 });
    assert.deepEqual(counts.feedback, { records: 1 });
    assert.deepEqual(counts.session_memory, { records: 1 });
    assert.deepEqual(counts.long_memory, { records: 1 });
    assert.deepEqual(counts["claim_judge_cache:local"], { records: 1 });
    assert.deepEqual(counts["claim_judge_cache:shared"], { records: 1 });
    assert.deepEqual(counts.semantic_cache, { records: 1 });
    // Without a database the usage ledger keeps nothing.
    assert.deepEqual(counts.tenant_usage, { records: 0 });
    assert.deepEqual(counts["tenant_usage:pending"], { records: 0 });
    // A pair: its membership, never the workspace's row.
    assert.deepEqual(counts.workspace_members, { records: 1 });
    assert.deepEqual(counts.workspaces, { notApplicable: true, records: 0 });
    assert.deepEqual(await recordsOf(normalizeTenantSelector(A)), before, "a dry run changes nothing");
    assert.equal(getSemanticCacheStats().entries, 3);
  });

  test("the export bundle holds only the tenant's records, document bytes included", async () => {
    const lines = await collectLines(state.service.exportTenant({ ...A, actor: { userId: "ops" } }));
    const header = lines[0];
    const summary = lines.at(-1);
    const records = lines.filter((line) => line.type === "record");
    const text = JSON.stringify(lines);

    assert.equal(header.type, "header");
    assert.equal(header.format, TENANT_EXPORT_FORMAT);
    assert.deepEqual(header.tenant, { userId: "alice", workspaceId: "acme" });
    assert.equal(summary.type, "summary");
    assert.equal(summary.complete, true);
    assert.ok(text.includes(MARKER_A));
    assert.equal(text.includes(MARKER_B), false, "no record of another tenant");
    assert.equal(text.includes(`${MARKER_A}-elsewhere`), false, "no record of A's user elsewhere");

    const byTable = summary.counts;

    for (const table of [
      "documents",
      "ingest_jobs",
      "upload_sessions",
      "tasks",
      "agent_runs",
      "agent_run_events",
      "workspace_artifacts",
      "feedback",
      "session_memory",
      "long_memory",
      "workspace_members",
      "admin_audit_events",
    ]) {
      assert.ok(byTable[table] >= 1, `exported ${table}`);
    }

    assert.equal(byTable.workspaces, undefined, "a pair export holds no workspace row");

    const document = records.find((line) => line.table === "documents").record;

    assert.ok(Buffer.from(document.fileBytes.base64, "base64").subarray(0, 5).equals(Buffer.from("%PDF-")));
    for (const line of records) {
      assert.ok(
        tenantSelectorMatches(normalizeTenantSelector(A), {
          userId:
            line.record.ownerUserId ??
            line.record.userId ??
            line.record.accessScope?.userId ??
            line.record.principal?.userId ??
            line.record.manifest?.ownerUserId,
          workspaceId:
            line.record.workspaceId ??
            line.record.accessScope?.workspaceId ??
            line.record.principal?.workspaceId ??
            line.record.manifest?.workspaceId ??
            (line.table === "long_memory" ? "acme" : undefined),
        }) || line.table === "agent_run_events",
        `${line.table} record belongs to A`
      );
    }

    const exported = (await state.adminAuditService.listEvents({ limit: 50 })).events.find(
      (event) => event.type === "admin.tenant.exported"
    );

    assert.equal(exported.principal.userId, "ops");
    assert.deepEqual(exported.details.tenant, { userId: "alice", workspaceId: "acme" });
    assert.equal(exported.details.counts.documents, 1);
    assert.equal(JSON.stringify(exported).includes(MARKER_A), false, "the audit event holds ids and counts only");
  });

  test("an applied erase refuses work in flight unless forced, then removes A everywhere and leaves B", async () => {
    const pendingJobId = "job-pending-alice";

    await state.ingestJobStore.enqueue({
      docId: "doc-in-flight",
      fileBytes: Buffer.from("%PDF-1.4 in flight"),
      fileName: "in-flight.pdf",
      jobId: pendingJobId,
      ownerUserId: A.userId,
      workspaceId: A.workspaceId,
    });

    const refused = await state.service.eraseTenant({ ...A, actor: { userId: "ops" }, dryRun: false });

    assert.equal(refused.status, "refused");
    assert.equal(refused.code, TENANT_LIFECYCLE_ERROR_CODES.activeWork);
    assert.deepEqual(refused.activeWork, { ingest_jobs: 1 });
    assert.equal((await recordsOf(normalizeTenantSelector(A))).documents, 1, "nothing deleted");

    const bBefore = await recordsOf(normalizeTenantSelector(B));
    const elsewhereBefore = await recordsOf(normalizeTenantSelector(A_ELSEWHERE));
    const result = await state.service.eraseTenant({
      ...A,
      actor: { userId: "ops" },
      dryRun: false,
      force: true,
      permissionId: "admin.tenants.erase",
      request: { method: "POST", path: "/admin/tenants/erase" },
    });
    const counts = tableCounts(result);

    assert.equal(result.status, "completed");
    assert.equal(result.complete, true);
    assert.equal(result.tombstoneRecorded, true);
    assert.equal(counts.ingest_jobs.deleted, 2);
    assert.equal(counts.ingest_temp_files.deleted, 1);
    assert.equal(counts.documents.deleted, 1);
    assert.equal(counts.long_memory.deleted, 1);
    assert.equal(counts["claim_judge_cache:shared"].deleted, 1);
    assert.equal(counts.semantic_cache.deleted, 1);

    assert.deepEqual(await recordsOf(normalizeTenantSelector(A)), {
      agentRuns: 0,
      artifacts: 0,
      claimJudge: { local: 0, shared: 0, sharedState: "redis" },
      documents: 0,
      feedback: 0,
      ingestJobs: 0,
      registry: 0,
      sessions: 0,
      tasks: 0,
      uploads: 0,
    });
    // A pair erase removes the membership and keeps the workspace, active.
    assert.equal(counts.workspace_members.deleted, 1);
    assert.equal((await state.tenantRegistry.getWorkspace(A.workspaceId)).status, "active");
    assert.equal(result.stores.find(({ store }) => store === "tenant_registry").workspaceStatus, undefined);
    assert.deepEqual(await recordsOf(normalizeTenantSelector(B)), bBefore, "B is untouched");
    assert.deepEqual(
      await recordsOf(normalizeTenantSelector(A_ELSEWHERE)),
      elsewhereBefore,
      "A's user in another workspace is untouched"
    );
    assert.deepEqual(state.longMemoryStore.memories.map((memory) => memory.userId), ["bob"]);

    // The chunks are gone from the local index; B's still answer.
    assert.deepEqual(
      await searchLocalDocuments({ docIds: ["doc-alice-acme"], queryVector: embedText(MARKER_A), topK: 5 }),
      []
    );
    assert.ok(
      (await searchLocalDocuments({ docIds: ["doc-bob-globex"], queryVector: embedText(MARKER_B), topK: 5 }))
        .length > 0
    );
    assert.deepEqual(
      (await readdir(path.join(state.uploadsDirectory, "ingest-tmp"))).sort(),
      [
        "ingest-job-2-bob-globex-1-00000000-0000-4000-8000-000000000002.pdf",
        "ingest-job-3-alice-globex-1-00000000-0000-4000-8000-000000000003.pdf",
      ]
    );
    assert.equal(getSemanticCacheStats().entries, 2, "only A's cached answer went");

    // The audit log keeps its events and gains a tombstone with ids and counts.
    const events = (await state.adminAuditService.listEvents({ limit: 50 })).events;
    const tombstone = events.find((event) => event.type === "admin.tenant.erased");

    assert.ok(events.some((event) => event.principal.userId === "alice" && event.type !== "admin.tenant.erased"));
    assert.equal(tombstone.principal.userId, "ops");
    assert.equal(tombstone.authorization.permissionId, "admin.tenants.erase");
    assert.equal(tombstone.details.outcome, "completed");
    assert.equal(tombstone.details.force, true);
    assert.deepEqual(tombstone.details.tenant, { userId: "alice", workspaceId: "acme" });
    assert.equal(tombstone.details.counts.documents, 1);
    assert.equal(JSON.stringify(tombstone).includes(MARKER_A), false);

    // Run again: nothing left, still complete.
    const again = await state.service.eraseTenant({ ...A, dryRun: false });

    assert.equal(again.status, "completed");
    assert.equal(Object.values(again.totals.deleted).reduce((total, count) => total + count, 0), 0);
  });

  test("a workspace-wide erase covers every user of the workspace", async () => {
    const result = await state.service.eraseTenant({ dryRun: true, workspaceId: "globex" });
    const counts = tableCounts(result);

    assert.equal(counts.documents.records, 2, "bob's and alice's documents in globex");
    assert.equal(counts.tasks.records, 2);
    assert.equal(result.stores.find(({ store }) => store === "long_memory").status, "not_applicable");
    assert.equal(counts["claim_judge_cache:shared"].records, 2);
    assert.deepEqual(counts.workspace_members, { records: 2 });
    assert.deepEqual(counts.workspaces, { records: 1 });
    assert.equal((await state.tenantRegistry.getWorkspace("globex")).status, "active", "a dry run marks nothing");
  });
});

// The registry and the usage ledger in an erase (rag/tenant-lifecycle.js):
// every other store is a quiet stand-in with nothing to erase, so nothing
// here reaches a module-level store.
describe("a workspace erase, the tenant registry and the usage ledger", () => {
  const WORKSPACE = "acme";
  const quiet = {
    countTenantRecords: async () => ({}),
    deleteTenantRecords: async () => ({}),
    listTenantRecords: async () => [],
  };

  const setup = async ({ failTasks = 0, registryOverrides = null, queuedTask = false } = {}) => {
    const registry = createTenantRegistryService({ cacheTtlMs: 60_000, store: createInMemoryTenantRegistryStore() });

    await registry.createWorkspace({ workspaceId: WORKSPACE });
    await registry.createWorkspace({ workspaceId: "globex" });
    await registry.putMember({ userId: "alice", workspaceId: WORKSPACE });
    await registry.putMember({ userId: "bob", workspaceId: WORKSPACE });
    await registry.putMember({ userId: "alice", workspaceId: "globex" });

    const taskStore = createInMemoryTaskStore();
    const tenants = [
      { userId: "alice", workspaceId: WORKSPACE },
      { userId: "bob", workspaceId: WORKSPACE },
      { userId: "alice", workspaceId: "globex" },
    ];

    for (const tenant of tenants) {
      await taskStore.upsert({
        accessScope: tenant,
        task: { id: `task-${tenant.userId}-${tenant.workspaceId}`, status: "waiting_for_user", type: "external_recommendation" },
      });
    }

    if (queuedTask) {
      await taskStore.upsert({
        accessScope: tenants[1],
        task: { id: "task-queued", status: "queued", type: "external_recommendation" },
      });
    }

    // What enforcement answers alice in acme, and the workspace's status,
    // at the moment the tasks are erased.
    const seen = [];
    let failures = failTasks;
    const tasks = {
      countTenantRecords: (selector) => taskStore.countTenantRecords(selector),
      listTenantRecords: (selector) => taskStore.listTenantRecords(selector),
      async deleteTenantRecords(selector) {
        const decision = await decideTenantMembership({ registry, userId: "alice", workspaceId: WORKSPACE });

        seen.push({
          decision: decision.allowed ? "allowed" : decision.code,
          status: (await registry.getWorkspace(WORKSPACE))?.status ?? null,
        });

        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("store down"), { code: "STORE_DOWN" });
        }

        return taskStore.deleteTenantRecords(selector);
      },
    };

    // A ledger with unflushed totals of three tenants (it would flush to
    // PostgreSQL; nothing here reaches a database).
    const ledger = createTenantUsageLedger({
      clearTimer: () => {},
      isDatabaseConfigured: () => true,
      isEnabled: () => true,
      query: async () => ({ rows: [] }),
      setTimer: () => ({ unref() {} }),
    });

    for (const tenant of tenants) {
      ledger.record(tenant, { chat_requests: 1 });
    }

    const adminAuditService = createAdminAuditService({ store: createInMemoryAdminAuditStore() });
    const service = createTenantLifecycleService({
      adminAuditService,
      agentRunStore: quiet,
      claimJudge: { erase: async () => ({ local: 0, shared: 0 }) },
      documents: {
        count: async () => ({ chunks: {}, documents: [] }),
        erase: async () => ({ chunks: {}, documents: [] }),
        resolveRecordStore: () => ({ status: "ok", store: quiet }),
      },
      feedbackStore: quiet,
      ingestJobStore: quiet,
      logger: { error() {} },
      longMemory: () => ({ status: "ok", store: quiet }),
      semanticCache: { count: () => 0, erase: () => 0 },
      sessionMemory: () => ({ status: "ok", store: quiet }),
      taskStore: tasks,
      tenantRegistry: registryOverrides ? { ...registry, ...registryOverrides(registry) } : registry,
      tenantUsageStore: createTenantUsageRecordStore({ isDatabaseConfigured: () => false, ledger }),
      uploadStore: { eraseUploadSessionsForTenant: async () => 0, listUploadSessionsForTenant: async () => [] },
      workspaceArtifactStore: quiet,
    });

    return { adminAuditService, ledger, registry, seen, service, taskStore };
  };

  const byStore = (result, id) => result.stores.find(({ store }) => store === id);

  test("marks the workspace deleting before any store is erased and removes its registry rows last", async () => {
    const { adminAuditService, ledger, registry, seen, service } = await setup({ queuedTask: true });
    const workspace = normalizeTenantSelector({ workspaceId: WORKSPACE });

    // A dry run and a refused erase change nothing, the status included.
    const dryRun = await service.eraseTenant({ workspaceId: WORKSPACE });

    assert.equal(dryRun.complete, true, `skipped: ${dryRun.skippedStores.join(", ")}`);
    assert.deepEqual(byStore(dryRun, "tenant_registry").tables, {
      workspace_members: { records: 2 },
      workspaces: { records: 1 },
    });
    assert.deepEqual(byStore(dryRun, "tenant_usage").tables["tenant_usage:pending"], { records: 2 });
    assert.equal((await service.eraseTenant({ dryRun: false, workspaceId: WORKSPACE })).status, "refused");
    assert.equal((await registry.getWorkspace(WORKSPACE)).status, "active");
    assert.equal(ledger.countPending(workspace), 2);

    const result = await service.eraseTenant({
      actor: { userId: "ops" },
      dryRun: false,
      force: true,
      permissionId: "admin.tenants.erase",
      workspaceId: WORKSPACE,
    });

    assert.equal(result.status, "completed", JSON.stringify(result.failure ?? result.skippedStores));
    assert.deepEqual(seen, [{ decision: "WORKSPACE_DELETING", status: "deleting" }], "requests refused while data goes");
    assert.deepEqual(result.stores.map(({ store }) => store).slice(-2), ["tenant_usage", "tenant_registry"]);
    assert.equal(byStore(result, "tenant_registry").workspaceStatus, "deleting");
    assert.deepEqual(byStore(result, "tenant_registry").tables, {
      workspace_members: { deleted: 2, records: 2 },
      workspaces: { deleted: 1, records: 1 },
    });
    assert.equal(byStore(result, "tenant_usage").tables["tenant_usage:pending"].deleted, 2);

    // The workspace and its memberships are gone; the user's other
    // workspace and its usage stay.
    assert.equal(await registry.getWorkspace(WORKSPACE), null);
    assert.deepEqual(await registry.listTenantRecords(workspace), []);
    assert.ok(await registry.getMember("globex", "alice"));
    assert.equal(ledger.countPending(workspace), 0);
    assert.equal(ledger.countPending(normalizeTenantSelector({ workspaceId: "globex" })), 1);

    const tombstone = (await adminAuditService.listEvents({ limit: 10 })).events.find(
      (event) => event.type === "admin.tenant.erased"
    );

    assert.equal(tombstone.details.counts.workspaces, 1);
    assert.equal(tombstone.details.counts.workspace_members, 2);
    assert.equal(tombstone.details.counts["tenant_usage:pending"], 2);

    // Running it again: not registered any more, nothing left.
    const again = await service.eraseTenant({ dryRun: false, workspaceId: WORKSPACE });

    assert.equal(again.status, "completed");
    assert.equal(byStore(again, "tenant_registry").workspaceStatus, "not_registered");
  });

  test("an erase that fails part-way leaves the workspace deleting and its rows in place; a second run finishes", async () => {
    const { registry, seen, service, taskStore } = await setup({ failTasks: 1 });
    const failed = await service.eraseTenant({ dryRun: false, workspaceId: WORKSPACE });

    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.failure, { code: "STORE_DOWN", store: "tasks" });
    assert.equal(byStore(failed, "tenant_registry").status, "not_attempted");
    assert.equal((await registry.getWorkspace(WORKSPACE)).status, "deleting");
    assert.equal((await registry.listMembers(WORKSPACE)).length, 2);
    assert.equal(
      (await decideTenantMembership({ registry, userId: "bob", workspaceId: WORKSPACE })).code,
      "WORKSPACE_DELETING"
    );

    const finished = await service.eraseTenant({ dryRun: false, workspaceId: WORKSPACE });

    assert.equal(finished.status, "completed");
    assert.equal(seen.length, 2);
    assert.equal(await registry.getWorkspace(WORKSPACE), null);
    assert.equal(taskStore.listTenantRecords(normalizeTenantSelector({ workspaceId: WORKSPACE })).length, 0);
  });

  test("a registry that cannot mark the workspace stops the erase before anything is deleted", async () => {
    const { registry, seen, service, taskStore } = await setup({
      registryOverrides: () => ({
        markWorkspaceDeleting: async () => {
          throw Object.assign(new Error("registry down"), { code: "08006" });
        },
      }),
    });
    const result = await service.eraseTenant({ dryRun: false, workspaceId: WORKSPACE });

    assert.equal(result.status, "failed");
    assert.deepEqual(result.failure, { code: "08006", store: "tenant_registry" });
    assert.equal(byStore(result, "tenant_registry").status, "failed");
    assert.ok(
      result.stores.filter(({ store }) => store !== "tenant_registry").every(({ status }) => status === "not_attempted")
    );
    assert.deepEqual(seen, [], "no store was erased");
    assert.equal(taskStore.listTenantRecords(normalizeTenantSelector({ workspaceId: WORKSPACE })).length, 2);
    assert.equal((await registry.getWorkspace(WORKSPACE)).status, "active");
  });

  test("a registry that cannot mark a workspace is reported unsupported, and a user erase marks nothing", async () => {
    const { registry, service } = await setup({ registryOverrides: () => ({ markWorkspaceDeleting: undefined }) });
    const result = await service.eraseTenant({ workspaceId: WORKSPACE });

    assert.equal(byStore(result, "tenant_registry").status, "unsupported");
    assert.deepEqual(result.skippedStores, ["tenant_registry"]);

    const pair = await (await setup()).service.eraseTenant({ dryRun: false, userId: "bob", workspaceId: WORKSPACE });

    assert.equal(pair.status, "completed");
    assert.equal(byStore(pair, "tenant_registry").workspaceStatus, undefined);
    assert.equal((await registry.getWorkspace(WORKSPACE)).status, "active");
  });

  test("the export holds the workspace row, its memberships and the ledger's rows", async () => {
    const { service } = await setup();
    const lines = await collectLines(service.exportTenant({ workspaceId: WORKSPACE }));
    const records = lines.filter((line) => line.type === "record");

    assert.deepEqual(
      records.filter((line) => line.store === "tenant_registry").map(({ record, table }) => [table, record.userId ?? null]),
      [
        ["workspace_members", "alice"],
        ["workspace_members", "bob"],
        ["workspaces", null],
      ]
    );
    assert.ok(lines[0].stores.some(({ status, store }) => store === "tenant_usage" && status === "ok"));
    assert.equal(lines.at(-1).complete, true);
  });
});

describe("the admin routes", () => {
  const state = {};
  const TOKENS = {
    "operator-token": { roles: ["admin.operator"], userId: "oscar" },
    "owner-platform-token": { roles: ["admin.owner"], userId: "olga" },
    "owner-tenantless-token": { roles: ["admin.owner"] },
    "owner-workspace-token": { roles: ["admin.owner"], userId: "wanda", workspaceId: "acme" },
  };

  const call = async ({ body, method = "POST", path: requestPath, token }) => {
    const response = await fetch(`${state.baseUrl}${requestPath}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { "x-api-key": token } : {}),
      },
      method,
    });

    return { headers: response.headers, status: response.status, text: await response.text() };
  };

  before(async () => {
    state.restoreEnv = snapshotEnv();
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_AUTH_TOKENS = JSON.stringify(TOKENS);
    delete process.env.API_AUTH_TOKEN;
    delete process.env.RAG_SEMANTIC_CACHE;
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-lifecycle-routes-"));
    state.originalRagDataDirectory = getRagDataDirectory();
    configureRagDataDirectory(path.join(state.tempRoot, "rag-data"));
    await resetDocumentRegistryStore();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    resetVectorStore();
    configureSessionMemoryStore(createInMemorySessionMemoryStore());
    configureLongMemoryStore(createLongMemoryStore());

    state.taskStore = createInMemoryTaskStore();
    state.adminAuditService = createAdminAuditService({ store: createInMemoryAdminAuditStore() });

    const app = await createApp({
      adminAuditService: state.adminAuditService,
      agentRunStore: createInMemoryAgentRunStore(),
      feedbackStore: createFileFeedbackStore({ directory: path.join(state.tempRoot, "feedback") }),
      healthService: {
        buildHealthReport: async () => ({ checks: {}, status: "ok" }),
        runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
      },
      ingestJobStore: createInMemoryIngestJobStore(),
      taskStore: state.taskStore,
      uploadSessionDirectory: path.join(state.tempRoot, "upload-sessions"),
      uploadsDirectory: path.join(state.tempRoot, "uploads"),
      workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    });

    for (const tenant of [A, B]) {
      await state.taskStore.upsert({
        accessScope: tenant,
        task: {
          id: `task-${tenant.userId}`,
          label: tenant === A ? MARKER_A : MARKER_B,
          status: "waiting_for_user",
          type: "external_recommendation",
        },
      });
    }

    state.server = createServer(app);
    await new Promise((resolve) => state.server.listen(0, "127.0.0.1", resolve));
    state.baseUrl = `http://127.0.0.1:${state.server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => state.server.close(resolve));
    state.restoreEnv();
    configureLongMemoryStore(null);
    await resetSessionMemoryStore();
    await resetDocumentRegistryStore();
    resetVectorStore();
    configureRagDataDirectory(state.originalRagDataDirectory);
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  test("only a platform admin.owner reaches them; the body names the target, not the caller", async () => {
    const erase = (token, body = { workspaceId: "acme", userId: "alice" }) =>
      call({ body, path: "/admin/tenants/erase", token });

    const operator = await erase("operator-token");

    assert.equal(operator.status, 403);
    assert.equal(JSON.parse(operator.text).adminAuthorization.permissionId, "admin.tenants.erase");

    const workspaceBound = await erase("owner-workspace-token");

    assert.equal(workspaceBound.status, 403);
    assert.equal(JSON.parse(workspaceBound.text).code, "TENANT_LIFECYCLE_PLATFORM_ONLY");

    // A platform principal without a user may call it too (auth.js
    // TENANTLESS_PLATFORM_PATHS), and naming a user in the body is the target.
    for (const token of ["owner-platform-token", "owner-tenantless-token"]) {
      const dryRun = await erase(token);
      const body = JSON.parse(dryRun.text);

      assert.equal(dryRun.status, 200, dryRun.text);
      assert.equal(body.status, "dry_run");
      assert.deepEqual(body.tenant, { userId: "alice", workspaceId: "acme" });
      assert.equal(body.stores.find(({ store }) => store === "tasks").tables.tasks.records, 1);
    }

    const invalid = await erase("owner-platform-token", {});

    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.text).code, TENANT_SELECTOR_ERROR_CODE);
    assert.equal((await erase("owner-platform-token", { dryRun: "no", workspaceId: "acme" })).status, 400);

    // Every decision is audited.
    const decisions = (await state.adminAuditService.listEvents({ limit: 50 })).events.filter(
      (event) => event.authorization.permissionId === "admin.tenants.erase"
    );

    assert.ok(decisions.some((event) => event.result === "denied" && event.principal.userId === "oscar"));
  });

  test("the export streams JSON Lines of the tenant only, then an applied erase removes it", async () => {
    const exported = await call({
      method: "GET",
      path: "/admin/tenants/export?workspaceId=acme&userId=alice",
      token: "owner-platform-token",
    });

    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type"), /application\/x-ndjson/);
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    assert.equal(exported.headers.get("cache-control"), "private, no-store");

    const lines = readJsonLines(exported.text);

    assert.equal(lines[0].type, "header");
    assert.equal(lines.at(-1).type, "summary");
    assert.ok(exported.text.includes(MARKER_A));
    assert.equal(exported.text.includes(MARKER_B), false);

    const applied = await call({
      body: { dryRun: false, userId: "alice", workspaceId: "acme" },
      path: "/admin/tenants/erase",
      token: "owner-platform-token",
    });
    const body = JSON.parse(applied.text);

    assert.equal(applied.status, 200, applied.text);
    assert.equal(body.status, "completed");
    assert.equal(await state.taskStore.get({ accessScope: A, taskId: "task-alice" }), null);
    assert.notEqual(await state.taskStore.get({ accessScope: B, taskId: "task-bob" }), null);
  });

  test("an empty userId is refused (400), never read as every user of the workspace", async () => {
    await state.taskStore.upsert({
      accessScope: { userId: "carl", workspaceId: "acme" },
      task: { id: "task-carl", label: "carl's task", status: "waiting_for_user", type: "external_recommendation" },
    });

    for (const userId of ["", "   "]) {
      const erase = await call({
        body: { dryRun: false, force: true, userId, workspaceId: "acme" },
        path: "/admin/tenants/erase",
        token: "owner-platform-token",
      });

      assert.equal(erase.status, 400, erase.text);
      assert.equal(JSON.parse(erase.text).code, TENANT_SELECTOR_ERROR_CODE);

      const exported = await call({
        method: "GET",
        path: `/admin/tenants/export?workspaceId=acme&userId=${encodeURIComponent(userId)}`,
        token: "owner-platform-token",
      });

      assert.equal(exported.status, 400, exported.text);
      assert.equal(JSON.parse(exported.text).code, TENANT_SELECTOR_ERROR_CODE);
      assert.equal(exported.text.includes("carl's task"), false, "no record was sent");
    }

    // Nothing was erased: carl, another user of acme, keeps his task.
    assert.notEqual(
      await state.taskStore.get({ accessScope: { userId: "carl", workspaceId: "acme" }, taskId: "task-carl" }),
      null
    );

    // The service refuses the same input whoever calls it.
    const service = createTenantLifecycleService({ taskStore: state.taskStore });

    await assert.rejects(
      () => service.eraseTenant({ dryRun: false, force: true, userId: "", workspaceId: "acme" }),
      (error) => error.code === TENANT_SELECTOR_ERROR_CODE
    );
    assert.throws(
      () => service.exportTenant({ userId: " ", workspaceId: "acme" }),
      (error) => error.code === TENANT_SELECTOR_ERROR_CODE
    );
  });

  test("with API auth off the routes refuse; the CLI is the tool there", async () => {
    process.env.API_AUTH_ENABLED = "false";

    try {
      const response = await call({ body: { workspaceId: "acme" }, path: "/admin/tenants/erase" });

      assert.equal(response.status, 403);
      assert.equal(JSON.parse(response.text).code, "TENANT_LIFECYCLE_REQUIRES_AUTH");
    } finally {
      process.env.API_AUTH_ENABLED = "true";
    }
  });
});

test("the CLI is a dry run unless --apply, and writes the export to a new file", async () => {
  assert.throws(() => parseTenantLifecycleArgs(["erase"]), /Name the tenant/);
  assert.throws(() => parseTenantLifecycleArgs(["export", "--workspace", "acme"]), /--output/);
  assert.throws(() => parseTenantLifecycleArgs(["export", "--workspace", "acme", "--output", "x", "--apply"]));
  assert.deepEqual(
    { ...parseTenantLifecycleArgs(["erase", "--workspace", "acme", "--user=alice"]) },
    {
      apply: false,
      command: "erase",
      force: false,
      help: false,
      json: false,
      serversStopped: false,
      user: "alice",
      workspace: "acme",
    }
  );

  const calls = [];
  const service = {
    eraseTenant: async (input) => {
      calls.push(input);
      return {
        activeWork: {},
        dryRun: input.dryRun,
        skippedStores: [],
        status: input.dryRun ? "dry_run" : "completed",
        stores: [{ status: "ok", store: "tasks", tables: { tasks: { records: 1 } } }],
        tenant: { userId: input.userId, workspaceId: input.workspaceId },
      };
    },
    exportTenant: () =>
      (async function* lines() {
        yield JSON.stringify({ type: "header" });
        yield JSON.stringify({ record: { id: 1 }, store: "tasks", table: "tasks", type: "record" });
        yield JSON.stringify({ complete: true, counts: { tasks: 1 }, records: 1, type: "summary" });
      })(),
  };
  const output = [];
  const dryRun = await runTenantLifecycleCommand(["erase", "--workspace", "acme"], {
    createService: async () => service,
    write: (text) => output.push(text),
  });

  assert.equal(dryRun.exitCode, 0);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].userId, null);
  assert.deepEqual(calls[0].request, { method: "CLI", path: "tenant-lifecycle.mjs", route: "tenant:erase" });
  assert.match(output.join(""), /Nothing was deleted/);

  await runTenantLifecycleCommand(["erase", "--workspace", "acme", "--user", "alice", "--apply", "--actor", "ops"], {
    createService: async () => service,
    write: () => {},
  });
  assert.equal(calls[1].dryRun, false);
  assert.deepEqual(calls[1].actor, { userId: "ops", workspaceId: "" });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-lifecycle-cli-"));

  try {
    const file = path.join(tempRoot, "export.jsonl");
    const exported = await runTenantLifecycleCommand(
      ["export", "--workspace", "acme", "--output", file],
      { createService: async () => service, write: () => {} }
    );

    assert.equal(exported.exitCode, 0);
    assert.equal(exported.result.summary.records, 1);

    const { readFile } = await import("node:fs/promises");

    assert.equal(readJsonLines(await readFile(file, "utf8")).length, 3);
    // The file must not exist yet: an export never overwrites one.
    await assert.rejects(() =>
      runTenantLifecycleCommand(["export", "--workspace", "acme", "--output", file], {
        createService: async () => service,
        write: () => {},
      })
    );
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("the CLI refuses an empty --user or --workspace instead of widening or moving the tenant", async () => {
  for (const argv of [
    ["erase", "--workspace", "acme", "--user", ""],
    ["erase", "--workspace", "acme", "--user="],
    ["erase", "--workspace", "acme", "--user", "   ", "--apply"],
    ["export", "--workspace", "acme", "--user=", "--output", "x"],
  ]) {
    assert.throws(() => parseTenantLifecycleArgs(argv), /--user needs a non-empty value/, argv.join(" "));
  }

  for (const argv of [
    ["erase", "--workspace", "", "--user", "alice"],
    ["erase", "--workspace=", "--user", "alice", "--apply"],
  ]) {
    assert.throws(() => parseTenantLifecycleArgs(argv), /--workspace needs a non-empty value/, argv.join(" "));
  }

  // Refused before any store is built or touched.
  let created = 0;

  await assert.rejects(
    () =>
      runTenantLifecycleCommand(["erase", "--workspace", "acme", "--user=", "--apply"], {
        createService: async () => {
          created += 1;
          return {};
        },
        write: () => {},
      }),
    /--user needs a non-empty value/
  );
  assert.equal(created, 0);
});

test("an export the caller stops reading early is audited as aborted, with the records handed out", async () => {
  const taskStore = createInMemoryTaskStore();

  for (const id of ["t-1", "t-2", "t-3"]) {
    await taskStore.upsert({
      accessScope: A,
      task: { id, label: MARKER_A, status: "waiting_for_user", type: "external_recommendation" },
    });
  }

  const notConfigured = () => ({ status: "not_configured", store: null });
  const createService = (adminAuditService) =>
    createTenantLifecycleService({
      adminAuditService,
      claimJudge: null,
      documents: null,
      longMemory: notConfigured,
      semanticCache: null,
      sessionMemory: notConfigured,
      taskStore,
      tenantRegistry: null,
      tenantUsageStore: null,
    });
  const exportedEvents = async (adminAuditService) =>
    (await adminAuditService.listEvents({ limit: 50 })).events.filter(
      (event) => event.type === "admin.tenant.exported"
    );

  // A client that disconnects after the header and one record (the route's
  // `break`): the generator is closed at a yield.
  const brokenAudit = createAdminAuditService({ store: createInMemoryAdminAuditStore() });
  const read = [];

  for await (const line of createService(brokenAudit).exportTenant({ ...A, actor: { userId: "ops" } })) {
    read.push(JSON.parse(line));

    if (read.filter((entry) => entry.type === "record").length === 1) {
      break;
    }
  }

  const [aborted] = await exportedEvents(brokenAudit);

  assert.ok(aborted, "the aborted export is audited");
  assert.equal(aborted.details.outcome, "aborted");
  assert.equal(aborted.authorization.reason, "tenant_export_aborted");
  assert.deepEqual(aborted.details.counts, { tasks: 1 });
  assert.deepEqual(aborted.details.tenant, { userId: "alice", workspaceId: "acme" });
  assert.equal(aborted.principal.userId, "ops");
  assert.equal(JSON.stringify(aborted).includes(MARKER_A), false, "ids and counts only");

  // A consumer whose loop body throws (a file that cannot be written): the
  // same, once.
  const throwingAudit = createAdminAuditService({ store: createInMemoryAdminAuditStore() });

  await assert.rejects(async () => {
    for await (const line of createService(throwingAudit).exportTenant({ ...A })) {
      if (JSON.parse(line).type === "record") {
        throw new Error("disk full");
      }
    }
  }, /disk full/);

  const thrown = await exportedEvents(throwingAudit);

  assert.equal(thrown.length, 1);
  assert.equal(thrown[0].details.outcome, "aborted");
  assert.deepEqual(thrown[0].details.counts, { tasks: 1 });

  // Read to the end: one event, with the real outcome, never a second one.
  const fullAudit = createAdminAuditService({ store: createInMemoryAdminAuditStore() });
  const lines = await collectLines(createService(fullAudit).exportTenant({ ...A }));
  const full = await exportedEvents(fullAudit);

  assert.equal(lines.at(-1).type, "summary");
  assert.equal(full.length, 1);
  assert.equal(full[0].details.outcome, lines.at(-1).status);
  assert.notEqual(full[0].details.outcome, "aborted");
  assert.equal(full[0].details.counts.tasks, 3);

  // Stopping on the summary line (after the outcome was recorded) adds nothing.
  const summaryAudit = createAdminAuditService({ store: createInMemoryAdminAuditStore() });

  for await (const line of createService(summaryAudit).exportTenant({ ...A })) {
    if (JSON.parse(line).type === "summary") break;
  }

  const summaryEvents = await exportedEvents(summaryAudit);

  assert.equal(summaryEvents.length, 1);
  assert.notEqual(summaryEvents[0].details.outcome, "aborted");
});

describe("the CLI erase and documents a running server keeps in memory", () => {
  const state = {};

  before(async () => {
    state.restoreEnv = snapshotEnv();
    state.standalone = process.env.DOCCOMPARE_STANDALONE;
    delete process.env.DOCCOMPARE_STANDALONE;
    delete process.env.RAG_SEMANTIC_CACHE;
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-lifecycle-cli-docs-"));
    state.originalRagDataDirectory = getRagDataDirectory();
    configureRagDataDirectory(path.join(state.tempRoot, "rag-data"));
    configureUploadSessionDirectory(path.join(state.tempRoot, "upload-sessions"));
    configureFeedbackDirectory(path.join(state.tempRoot, "feedback"));
    // The standalone setup: the file-backed registry and the local index.
    await resetDocumentRegistryStore();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    resetVectorStore();
    configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async (query) => embedText(query),
      embedTexts: async (texts) => texts.map(embedText),
    });
    state.sessionStore = createInMemorySessionMemoryStore();
    configureSessionMemoryStore(state.sessionStore);

    const pdfPath = path.join(state.tempRoot, "alice.pdf");

    await writeFile(pdfPath, buildTextPdf({ pages: [[`The ${MARKER_A} policy needs manager approval.`]] }));
    await ingestDocument({
      docId: "doc-cli-alice",
      fileName: `${MARKER_A}.pdf`,
      filePath: pdfPath,
      ownerUserId: A.userId,
      workspaceId: A.workspaceId,
    });
    await runWithDatabaseTenant(A, () =>
      recordSessionTurn({
        accessScope: { ...A, authenticated: true },
        answer: `${MARKER_A} answer`,
        documents: [],
        query: `About ${MARKER_A}?`,
        sessionId: "cli-session",
      })
    );
  });

  after(async () => {
    state.restoreEnv();
    if (state.standalone === undefined) delete process.env.DOCCOMPARE_STANDALONE;
    else process.env.DOCCOMPARE_STANDALONE = state.standalone;
    resetOpenAIProvider();
    await resetSessionMemoryStore();
    await resetDocumentRegistryStore();
    resetVectorStore();
    configureRagDataDirectory(state.originalRagDataDirectory);
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  const chunksOfAlice = async () =>
    (await searchLocalDocuments({ docIds: ["doc-cli-alice"], queryVector: embedText(MARKER_A), topK: 5 })).length;

  test("only a PostgreSQL registry with pgvector or Qdrant is shared with running servers", () => {
    assert.deepEqual(describeCliDocumentEraseBlockers({ registryShared: true, vectorStoreProvider: "pgvector" }), []);
    assert.deepEqual(describeCliDocumentEraseBlockers({ registryShared: true, vectorStoreProvider: "qdrant" }), []);
    assert.deepEqual(describeCliDocumentEraseBlockers({ registryShared: true, vectorStoreProvider: "local" }), [
      "local_vector_index_in_server_memory",
    ]);
    assert.deepEqual(describeCliDocumentEraseBlockers({ registryShared: false, vectorStoreProvider: "qdrant" }), [
      "document_registry_in_server_memory",
    ]);
    assert.deepEqual(describeCliDocumentEraseBlockers({ registryShared: false, vectorStoreProvider: "local" }), [
      "document_registry_in_server_memory",
      "local_vector_index_in_server_memory",
    ]);

    assert.equal(parseTenantLifecycleArgs(["erase", "--workspace", "acme", "--servers-stopped"]).serversStopped, true);
    assert.throws(
      () => parseTenantLifecycleArgs(["export", "--workspace", "acme", "--output", "x", "--servers-stopped"]),
      /belong to erase/
    );
  });

  test("without --servers-stopped an applied erase leaves the documents and says it is not complete", async () => {
    const service = await createCliTenantLifecycleService({ command: "erase" });

    assert.deepEqual(service.withheldStores, {
      documents: ["document_registry_in_server_memory", "local_vector_index_in_server_memory"],
    });

    const result = await service.eraseTenant({ ...A, dryRun: false, force: true });
    const documentsStore = result.stores.find(({ store }) => store === "documents");

    assert.equal(documentsStore.status, "unsupported");
    assert.ok(result.skippedStores.includes("documents"));
    assert.equal(result.status, "partial");
    assert.equal(result.complete, false);
    assert.equal((await listStoredDocumentsForTenant(normalizeTenantSelector(A))).length, 1, "the document stays");
    assert.ok((await chunksOfAlice()) > 0, "its chunks stay");

    // The in-memory session store is this process's own copy, not a running
    // server's: reported as not reached, never as erased.
    assert.equal(result.stores.find(({ store }) => store === "session_memory").status, "not_configured");
    assert.equal((await state.sessionStore.listTenantRecords(normalizeTenantSelector(A))).length, 1);

    // The command prints why and exits 1.
    const output = [];
    const seen = [];
    const command = await runTenantLifecycleCommand(["erase", "--workspace", "acme", "--user", "alice", "--apply", "--force"], {
      createService: async (options) => {
        seen.push(options);
        return createCliTenantLifecycleService(options);
      },
      write: (text) => output.push(text),
    });

    assert.deepEqual(seen, [{ command: "erase", serversStopped: false }]);
    assert.equal(command.exitCode, 1);
    assert.deepEqual(command.result.withheldStores, service.withheldStores);
    assert.ok(output.join("").includes(CLI_DOCUMENTS_WITHHELD_HINT));
    assert.match(output.join(""), /Not reached from here: .*documents/);

    // The export only reads, so it keeps the documents.
    assert.equal((await createCliTenantLifecycleService({ command: "export" })).withheldStores, undefined);
  });

  test("with --servers-stopped the CLI erases the documents and their chunks", async () => {
    const output = [];
    const seen = [];
    const command = await runTenantLifecycleCommand(
      ["erase", "--workspace", "acme", "--user", "alice", "--apply", "--force", "--servers-stopped", "--json"],
      {
        createService: async (options) => {
          seen.push(options);
          return createCliTenantLifecycleService(options);
        },
        write: (text) => output.push(text),
      }
    );

    assert.deepEqual(seen, [{ command: "erase", serversStopped: true }]);
    assert.equal(command.result.withheldStores, undefined);

    const documentsStore = command.result.stores.find(({ store }) => store === "documents");

    assert.equal(documentsStore.status, "ok");
    assert.equal(documentsStore.tables.documents.deleted, 1);
    assert.equal(command.result.skippedStores.includes("documents"), false);
    assert.equal((await listStoredDocumentsForTenant(normalizeTenantSelector(A))).length, 0);
    assert.equal(await chunksOfAlice(), 0);
    assert.equal(JSON.parse(output.join("")).withheldStores, undefined);
  });
});
