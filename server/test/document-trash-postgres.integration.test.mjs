import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// The document trash (migration 042, DOCUMENT_TRASH_RETENTION_HOURS,
// rag/document-trash.js) through the real app on a real PostgreSQL with
// pgvector and row-level security enforced:
//
// * DELETE /documents/:docId moves the document into the trash: its chunks
//   leave the index at once (search and /chat cannot reach it), the list and
//   the download no longer show it, its queued ingest job is cancelled, the
//   row and its bytes stay with the deleting scope, and nothing is redacted
//   yet;
// * GET /documents/trash shows it to its own tenant only, and the other
//   tenant's restore answers 404 and changes nothing;
// * an upload of the trashed bytes creates a new document, and restoring
//   while that one exists refuses with DOCUMENT_RESTORE_DUPLICATE;
// * POST /documents/:docId/restore re-chunks and re-embeds the stored bytes
//   (content version 2): listed, downloadable and searchable again;
// * the retention sweep purges what is past the window only, redacts then
//   (DOCUMENT_DELETE_REDACTION), and leaves the other tenant alone;
// * the storage quota counts a trashed document; POST /documents/clear moves
//   the scope's documents into the trash; the tenant erase removes trashed
//   documents too; the data-access audit records the trash, restore and purge.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. It provisions its own database owned
// by a non-superuser login and drops everything after.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

const MODEL = "document-trash-it-embed";
const TOPICS = ["alpha", "beta", "gamma", "delta"];
const DIMENSIONS = TOPICS.length + 1;
const ALICE = Object.freeze({ userId: "alice", workspaceId: "ws-a" });
const BOB = Object.freeze({ userId: "bob", workspaceId: "ws-b" });
const TOKENS = {
  "alice-token": ALICE,
  "bob-token": BOB,
};
const AS_ALICE = { "x-api-key": "alice-token" };
const AS_BOB = { "x-api-key": "bob-token" };

const embedFor = (text) => {
  const lower = String(text).toLowerCase();

  return [...TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0)), 0.05];
};

const embeddingProvider = {
  completeText: async () => "unused [Source 1]",
  embedQuery: async (query) => embedFor(query),
  embedTexts: async (texts) => texts.map((text) => embedFor(text)),
};

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const silentLogger = { error: () => {}, log: () => {}, warn: () => {} };

if (!adminDatabaseUrl) {
  test("document trash PostgreSQL integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `doc_trash_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `doc_trash_it_tenant_${suffix}`;
  const systemRole = `doc_trash_it_system_${suffix}`;
  const databaseName = `doc_trash_it_${suffix}`;
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

  const ENV = {
    ADMIN_AUDIT_DATA_EVENTS: "on",
    AGENT_RUN_STORE_PROVIDER: "postgres",
    API_AUTH_ENABLED: "true",
    API_AUTH_TOKENS: JSON.stringify(TOKENS),
    DOCUMENT_DELETE_REDACTION: "on",
    DOCUMENT_TRASH_RETENTION_HOURS: "24",
    LONG_MEMORY_DATABASE_URL: "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "document-trash-it-key",
    OPENAI_EMBEDDING_MODEL: MODEL,
    PDF_PARSER: "pdfjs",
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_SYSTEM_ROLE: systemRole,
    POSTGRES_TENANT_ROLE: tenantRole,
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    RAG_HYBRID_ENABLED: "true",
    RAG_INGEST_MODE: "sync",
    RAG_LONG_MEMORY_ENABLED: "false",
    RATE_LIMIT_ENABLED: "false",
    TASK_STORE_PROVIDER: "postgres",
    VECTOR_STORE_PROVIDER: "pgvector",
    WORKSPACE_ARTIFACT_STORE_PROVIDER: "postgres",
  };

  let modules;
  let tempRoot;
  let app;
  let server;
  let baseUrl;
  const originalEnv = new Map();

  const q = (sql, values = []) => modules.postgres.queryPostgres(sql, values);
  const call = async (method, requestPath, { body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      method,
    });
    const text = await response.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { json, status: response.status, text };
  };
  const pdfFor = (topic) => buildTextPdf({ pages: [[`The ${topic} policy needs manager approval.`]] });
  const ingest = async (tenant, docId, topic, { deduplicate = false } = {}) => {
    const filePath = path.join(tempRoot, `${docId}.pdf`);

    await writeFile(filePath, pdfFor(topic));

    return modules.tenant.runWithDatabaseTenant(tenant, () =>
      modules.rag.ingestDocument({
        deduplicate,
        docId,
        fileName: `${topic}.pdf`,
        filePath,
        ownerUserId: tenant.userId,
        workspaceId: tenant.workspaceId,
      })
    );
  };
  const search = (tenant, docIds, topic) =>
    modules.tenant.runWithDatabaseTenant(tenant, () =>
      modules.vectorStore.searchDocumentsWithRoutes({
        docIds,
        queryText: topic,
        queryVector: embedFor(topic),
        topK: 3,
      })
    );
  const chunkCount = async (docId) =>
    Number((await q(`SELECT COUNT(*)::int AS n FROM rag_document_chunks WHERE doc_id = $1`, [docId])).rows[0].n);
  const documentRow = async (docId) =>
    (
      await q(
        `SELECT doc_id, deleted_at, deleted_by_user_id, deleted_by_workspace_id, content_version,
                octet_length(file_bytes) AS byte_count
         FROM rag_documents WHERE doc_id = $1`,
        [docId]
      )
    ).rows[0] ?? null;
  const dataEvents = async (userId, actionId) =>
    (
      await q(
        `SELECT data_access FROM rag_admin_audit_events
         WHERE user_id = $1 AND event_type = 'data.access' AND action_id = $2 ORDER BY id`,
        [userId, actionId]
      )
    ).rows.map((row) => (typeof row.data_access === "string" ? JSON.parse(row.data_access) : row.data_access));
  const feedbackExcerpt = async () =>
    (
      await q(`SELECT citations FROM rag_feedback WHERE owner_user_id = 'alice' ORDER BY id LIMIT 1`)
    ).rows[0]?.citations?.[0]?.excerpt;

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "document-trash-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    for (const [key, value] of Object.entries({
      ...ENV,
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, {
        password: ownerPassword,
        user: ownerRole,
      }),
      RAG_DATA_DIRECTORY: tempRoot,
    })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    const [config, postgres, tenant, migrations, registry, rag, openai, vectorStore, retention, retentionSql, appModule, feedback] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/doc-registry.js"),
        import("../rag/index.js"),
        import("../rag/openai.js"),
        import("../rag/vector-store.js"),
        import("../rag/retention.js"),
        import("../rag/retention-sql.js"),
        import("../app.js"),
        import("../feedback.js"),
      ]);

    modules = { config, feedback, migrations, openai, postgres, rag, registry, retention, retentionSql, tenant, vectorStore };
    config.configureEmbeddingDimensions(DIMENSIONS);
    openai.configureOpenAIProvider(embeddingProvider);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
    await migrations.runPostgresMigrations();
    await registry.initializeDocumentRegistry();

    app = await appModule.createApp({
      healthService: okHealthService,
      uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
      uploadsDirectory: path.join(tempRoot, "uploads"),
    });
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await ingest(ALICE, "doc-a1", "alpha");
    await ingest(ALICE, "doc-a2", "gamma");
    await ingest(BOB, "doc-b1", "beta");
    await ingest(BOB, "doc-b2", "delta");

    // A's answer feedback that cites doc-a1, which the purge (not the move
    // into the trash) redacts; and a queued ingest job for doc-a1.
    await tenant.runWithDatabaseTenant(ALICE, async () => {
      await feedback.getDefaultFeedbackStore().recordFeedback(
        feedback.buildFeedbackRecord({
          accessScope: ALICE,
          payload: {
            answerText: "The alpha policy needs approval [Source 1].",
            citations: [{ docId: "doc-a1", excerpt: "The alpha policy needs manager approval." }],
            feedbackType: "helpful",
            question: "What does the alpha policy say?",
          },
        })
      );
      await app.locals.services.ingestJobStore.enqueue({
        docId: "doc-a1",
        fileBytes: Buffer.from("%PDF-1.4 pending replacement"),
        fileName: "alpha-v2.pdf",
        kind: "replace",
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      });
    });
  });

  after(async () => {
    try {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      await app?.locals?.stop?.();
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      modules?.vectorStore.resetVectorStore();
      await modules?.registry.resetDocumentRegistryStore();
      await modules?.postgres.resetPostgresPool();
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${systemRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("DELETE moves the document into the trash: out of search, the list, the download and /chat", async () => {
    assert.equal((await search(ALICE, ["doc-a1"], "alpha")).results.length > 0, true, "searchable before");
    assert.ok((await chunkCount("doc-a1")) > 0);

    const deleted = await call("DELETE", "/documents/doc-a1", { headers: AS_ALICE });

    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.deleted, true);
    assert.equal(deleted.json.trashed, true);
    assert.equal(deleted.json.document.docId, "doc-a1");
    assert.equal(
      Date.parse(deleted.json.purgeAfter) - Date.parse(deleted.json.document.deletedAt),
      24 * 60 * 60 * 1000
    );

    // The row and its bytes stay, marked with the deleting scope; the chunks go.
    const row = await documentRow("doc-a1");

    assert.ok(row.deleted_at, "deleted_at is set");
    assert.equal(row.deleted_by_user_id, "alice");
    assert.equal(row.deleted_by_workspace_id, "ws-a");
    assert.ok(Number(row.byte_count) > 0, "the PDF bytes are kept");
    assert.equal(await chunkCount("doc-a1"), 0);
    assert.deepEqual((await search(ALICE, ["doc-a1"], "alpha")).results, []);

    const listed = await call("GET", "/documents", { headers: AS_ALICE });

    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.map((document) => document.docId), ["doc-a2"]);
    assert.equal((await call("GET", "/documents/doc-a1/file", { headers: AS_ALICE })).status, 404);

    const chat = await call("POST", "/chat", {
      body: { docIds: ["doc-a1"], question: "What does the alpha policy say?" },
      headers: AS_ALICE,
    });

    assert.equal(chat.status, 404, chat.text);

    // The queued job was cancelled, as for a delete; nothing was redacted yet.
    const job = (await q(`SELECT status, canceled_reason FROM rag_ingest_jobs WHERE doc_id = 'doc-a1'`)).rows[0];

    assert.deepEqual({ ...job }, { canceled_reason: "document_deleted", status: "failed" });
    assert.equal(await feedbackExcerpt(), "The alpha policy needs manager approval.");

    const trashEvents = await dataEvents("alice", "document.trash");

    assert.deepEqual(trashEvents.map((event) => event.outcome), ["requested", "succeeded"]);
  });

  test("the trash shows to its own tenant only; the other tenant's restore answers 404 and changes nothing", async () => {
    const aliceTrash = await call("GET", "/documents/trash", { headers: AS_ALICE });

    assert.equal(aliceTrash.status, 200);
    assert.deepEqual(aliceTrash.json.map((document) => document.docId), ["doc-a1"]);
    assert.ok(aliceTrash.json[0].deletedAt);
    assert.ok(aliceTrash.json[0].purgeAfter);
    assert.equal(aliceTrash.json[0].deletedByUserId, "alice");

    const bobTrash = await call("GET", "/documents/trash", { headers: AS_BOB });

    assert.equal(bobTrash.status, 200);
    assert.deepEqual(bobTrash.json, []);

    for (const docId of ["doc-a1", "doc-a2"]) {
      const restore = await call("POST", `/documents/${docId}/restore`, { body: {}, headers: AS_BOB });

      assert.equal(restore.status, 404, restore.text);
      assert.equal(restore.text.includes("alpha"), false);
    }

    // A restore of a document that is not in the trash is a 404 too.
    assert.equal((await call("POST", "/documents/doc-a2/restore", { body: {}, headers: AS_ALICE })).status, 404);
    assert.ok((await documentRow("doc-a1")).deleted_at, "still in the trash");
    assert.equal((await call("DELETE", "/documents/doc-a1", { headers: AS_BOB })).status, 404);
  });

  test("an upload of the trashed bytes is a new document; restoring then refuses as a duplicate", async () => {
    const uploaded = await ingest(ALICE, "doc-a1-again", "alpha", { deduplicate: true });

    assert.equal(uploaded.docId, "doc-a1-again");
    assert.equal(uploaded.duplicate, undefined, "a trashed document is no duplicate");

    const refused = await call("POST", "/documents/doc-a1/restore", { body: {}, headers: AS_ALICE });

    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, "DOCUMENT_RESTORE_DUPLICATE");
    assert.equal(refused.json.duplicateDocId, "doc-a1-again");
    assert.ok((await documentRow("doc-a1")).deleted_at, "the refused restore changed nothing");

    assert.equal((await call("DELETE", "/documents/doc-a1-again", { headers: AS_ALICE })).status, 200);
  });

  test("a restore re-chunks and re-embeds the stored bytes: listed, downloadable and searchable again", async () => {
    const restored = await call("POST", "/documents/doc-a1/restore", { body: {}, headers: AS_ALICE });

    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.restored, true);
    assert.equal(restored.json.document.docId, "doc-a1");
    assert.equal(restored.json.document.version, 2);

    const row = await documentRow("doc-a1");

    assert.equal(row.deleted_at, null);
    assert.equal(row.deleted_by_user_id, null);
    assert.equal(Number(row.content_version), 2);
    assert.ok((await chunkCount("doc-a1")) > 0);
    assert.equal(
      Number(
        (
          await q(
            `SELECT COUNT(*)::int AS n FROM rag_document_chunks WHERE doc_id = 'doc-a1' AND metadata->>'documentVersion' = '2'`
          )
        ).rows[0].n
      ),
      await chunkCount("doc-a1")
    );
    assert.equal((await search(ALICE, ["doc-a1"], "alpha")).results[0]?.document.metadata.docId, "doc-a1");

    const listed = await call("GET", "/documents", { headers: AS_ALICE });

    assert.deepEqual(listed.json.map((document) => document.docId).sort(), ["doc-a1", "doc-a2"]);
    assert.equal((await call("GET", "/documents/doc-a1/file?version=2", { headers: AS_ALICE })).status, 200);
    assert.deepEqual(
      (await call("GET", "/documents/trash", { headers: AS_ALICE })).json.map((document) => document.docId),
      ["doc-a1-again"]
    );
    assert.deepEqual((await dataEvents("alice", "document.restore")).map((event) => event.outcome).slice(-1), [
      "succeeded",
    ]);
  });

  test("the storage quota counts a trashed document until the purge", async () => {
    const totals = async () =>
      (await q(`SELECT document_count, document_bytes FROM rag_documents_storage_totals('ws-a', 'alice')`)).rows[0];
    const before = await totals();

    // doc-a1, doc-a2 and the trashed doc-a1-again.
    assert.equal(Number(before.document_count), 3);
  });

  test("a stored file whose plaintext begins with a reserved magic is not restored (415)", async () => {
    await ingest(ALICE, "doc-a3", "epsilon");
    assert.equal((await call("DELETE", "/documents/doc-a3", { headers: AS_ALICE })).status, 200);
    // As an upload from before the upload checks stored it: a PDF prefixed
    // with the working-file magic ("\0ARTWRK" + 1), which every working-file
    // reader would take for a damaged working file (a 500 before).
    await q(`UPDATE rag_documents SET file_bytes = decode('0041525457524b01', 'hex') || file_bytes WHERE doc_id = 'doc-a3'`);

    const refused = await call("POST", "/documents/doc-a3/restore", { body: {}, headers: AS_ALICE });

    assert.equal(refused.status, 415, refused.text);
    assert.equal(refused.json.code, "DOCUMENT_RESTORE_RESERVED_PREFIX");
    assert.ok((await documentRow("doc-a3")).deleted_at, "the refused restore changed nothing");
    assert.equal(await chunkCount("doc-a3"), 0);

    // Out of the way of the sweep and erase cases below.
    await q(`DELETE FROM rag_documents WHERE doc_id = 'doc-a3'`);
  });

  test("the sweep purges what is past the window only, redacts then, and leaves the other tenant alone", async () => {
    assert.equal((await call("DELETE", "/documents/doc-a1", { headers: AS_ALICE })).status, 200);
    assert.equal((await call("DELETE", "/documents/doc-b1", { headers: AS_BOB })).status, 200);
    assert.equal(await feedbackExcerpt(), "The alpha policy needs manager approval.", "trash time redacts nothing");

    // doc-a1 has been in the trash longer than the window; the others not.
    await q(`UPDATE rag_documents SET deleted_at = NOW() - INTERVAL '25 hours' WHERE doc_id = 'doc-a1'`);

    const targets = modules.retention.resolveRetentionTargets({
      hostsApiTier: true,
      services: app.locals.services,
    });

    assert.deepEqual(
      targets.database.map((target) => `${target.id}=${target.hours ?? target.days}`),
      ["document_trash=24"]
    );

    const report = await modules.retention
      .createRetentionSweeper({ intervalMs: 0, logger: silentLogger, targets })
      .sweep();

    assert.equal(report.document_trash.deleted, 1, JSON.stringify(report));
    assert.equal(await documentRow("doc-a1"), null, "purged with its bytes");
    assert.equal(await feedbackExcerpt(), "[source document deleted]", "redacted at purge time");
    assert.deepEqual(
      (await call("GET", "/documents/trash", { headers: AS_ALICE })).json.map((document) => document.docId),
      ["doc-a1-again"]
    );
    assert.equal((await call("POST", "/documents/doc-a1/restore", { body: {}, headers: AS_ALICE })).status, 404);

    // Bob's trash and documents are untouched.
    assert.deepEqual(
      (await call("GET", "/documents/trash", { headers: AS_BOB })).json.map((document) => document.docId),
      ["doc-b1"]
    );
    assert.equal((await search(BOB, ["doc-b2"], "delta")).results[0]?.document.metadata.docId, "doc-b2");

    const purgeEvents = await dataEvents("alice", "document.purge");

    assert.equal(purgeEvents.length, 1);
    assert.deepEqual(purgeEvents[0].resourceIds, ["doc-a1"]);
    assert.equal(purgeEvents[0].outcome, "succeeded");
    assert.deepEqual(await dataEvents("bob", "document.purge"), []);
  });

  test("POST /documents/clear moves the scope's documents into the trash", async () => {
    const cleared = await call("POST", "/documents/clear", { body: {}, headers: AS_BOB });

    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.trashed, true);
    assert.deepEqual(cleared.json.documents.map((document) => document.docId), ["doc-b2"]);
    assert.deepEqual((await call("GET", "/documents", { headers: AS_BOB })).json, []);
    assert.deepEqual(
      (await call("GET", "/documents/trash", { headers: AS_BOB })).json.map((document) => document.docId).sort(),
      ["doc-b1", "doc-b2"]
    );
    assert.equal(await chunkCount("doc-b2"), 0);
    assert.deepEqual(
      (await call("GET", "/documents", { headers: AS_ALICE })).json.map((document) => document.docId),
      ["doc-a2"]
    );
  });

  test("the tenant erase removes trashed documents too", async () => {
    const result = await app.locals.services.tenantLifecycleService.eraseTenant({
      ...BOB,
      actor: { userId: "ops" },
      dryRun: false,
      force: true,
      permissionId: "admin.tenants.erase",
    });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(
      Number((await q(`SELECT COUNT(*)::int AS n FROM rag_documents WHERE owner_user_id = 'bob'`)).rows[0].n),
      0
    );
    assert.equal(
      Number((await q(`SELECT COUNT(*)::int AS n FROM rag_documents WHERE owner_user_id = 'alice'`)).rows[0].n),
      2,
      "alice keeps doc-a2 and her trashed doc-a1-again"
    );
  });
}
