import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// Encryption at rest with crypto-shred (TENANT_ENCRYPTION=on, tenant
// isolation phase 5) on a real PostgreSQL, through the app's own routes:
//
// * two tenants upload over HTTP; every rag_documents.file_bytes row, the
//   async ingest job's bytes and every stage output hold an envelope, never
//   the known plaintext marker, and the content hash is the plaintext's;
// * download, /chat, the staged ingest worker, an index-version build and the
//   tenant export all see the plaintext;
// * a ciphertext moved into the other tenant's row fails closed;
// * encrypt-existing turns a legacy plaintext row into an envelope and rewrap
//   moves it to a rotated key version;
// * a workspace erase destroys that workspace's key (named in the tombstone),
//   so a copy of its row put back from a "backup" stays undecryptable, while
//   the other tenant reads on as before.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. It provisions its own database owned
// by a non-superuser login and drops everything after. The keystore and the
// master key live in a temp directory, never under server/data.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

const MODEL_A = "tenant-encryption-embed-a";
const MODEL_B = "tenant-encryption-embed-b";
const DIMENSIONS = { [MODEL_A]: 32, [MODEL_B]: 16 };
const ALICE = Object.freeze({ userId: "alice", workspaceId: "ws-a" });
const BOB = Object.freeze({ userId: "bob", workspaceId: "ws-b" });
// Hyphenated markers: base64 never holds a hyphen, so a search through
// exported bytes cannot find them by chance.
const ALICE_MARKER = "alpha-zebra";
const BOB_MARKER = "beta-quokka";

const embeddingProvider = {
  completeText: async (prompt) => buildFakeChatAnswer({ messages: [{ content: String(prompt), role: "user" }] }),
  embedQuery: async (query, options) =>
    hashEmbedding(query, DIMENSIONS[options?.embeddingSpace?.model ?? MODEL_A] ?? DIMENSIONS[MODEL_A]),
  embedTexts: async (texts, options) =>
    texts.map((text) =>
      hashEmbedding(text, DIMENSIONS[options?.embeddingSpace?.model ?? MODEL_A] ?? DIMENSIONS[MODEL_A])
    ),
};

if (!adminDatabaseUrl) {
  test("tenant encryption PostgreSQL integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `tenant_enc_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `tenant_enc_it_tenant_${suffix}`;
  const systemRole = `tenant_enc_it_system_${suffix}`;
  const databaseName = `tenant_enc_it_${suffix}`;
  const TOKENS = {
    alice: `alice-${randomBytes(8).toString("hex")}`,
    bob: `bob-${randomBytes(8).toString("hex")}`,
  };
  const withDatabase = (url, name, { password, user } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const adminQuery = async (url, sql, values = []) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql, values);
    } finally {
      await client.end();
    }
  };
  // Straight to the database as its owner, bypassing the app: what a backup
  // or an attacker with database access sees.
  const raw = (sql, values = []) =>
    adminQuery(withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole }), sql, values);

  let modules;
  let tempRoot;
  let server;
  let baseUrl;
  let service;
  let ingestJobStore;
  const documents = {};
  const pdfs = {};

  const pdfFor = (marker) =>
    buildTextPdf({ pages: [[`The ${marker} policy needs manager approval.`, `Every ${marker} request is logged.`]] });

  const request = async (route, { body, form, method = "GET", token } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-api-key": token,
      },
      method,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;

    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      json = null;
    }

    return { bytes, json, status: response.status };
  };

  const upload = async (token, name, bytes) => {
    const form = new FormData();

    form.append("file", new Blob([bytes], { type: "application/pdf" }), `${name}.pdf`);

    const answer = await request("/upload", { form, method: "POST", token });

    assert.equal(answer.status, 201, answer.bytes.toString("utf8"));
    return answer.json.docId;
  };

  const storedRow = async (docId) =>
    (await raw(`SELECT doc_id, file_bytes, owner_user_id, workspace_id, content_sha256 FROM rag_documents WHERE doc_id = $1`, [docId]))
      .rows[0];

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-encryption-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    Object.assign(process.env, {
      AGENT_EXECUTION_PLANNER: "deterministic",
      AGENT_INTENT_PLANNER: "deterministic",
      AGENT_PLANNER_ROLLOUT: "deterministic",
      AGENT_RUN_STORE_PROVIDER: "postgres",
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: JSON.stringify({ [TOKENS.alice]: ALICE, [TOKENS.bob]: BOB }),
      LONG_MEMORY_DATABASE_URL: "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "tenant-encryption-it-key",
      OPENAI_EMBEDDING_MODEL: MODEL_A,
      PDF_PARSER: "pdfjs",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, {
        password: ownerPassword,
        user: ownerRole,
      }),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_SYSTEM_ROLE: systemRole,
      // Every new PostgreSQL path must bind a tenant or the system.
      POSTGRES_TENANT_CONTEXT: "strict",
      POSTGRES_TENANT_ROLE: tenantRole,
      // The trash keeps a deleted document's envelope until the purge, and a
      // restore parses its decrypted bytes again.
      DOCUMENT_TRASH_RETENTION_HOURS: "24",
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
      RAG_CLAIM_JUDGE: "off",
      RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
      RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS[MODEL_A]),
      RAG_HYBRID_ENABLED: "true",
      RAG_INGEST_MODE: "sync",
      RAG_LONG_MEMORY_ENABLED: "false",
      RAG_OBSERVABILITY_ENABLED: "false",
      RAG_RERANK_ENABLED: "false",
      RAG_SEMANTIC_CACHE: "off",
      RATE_LIMIT_ENABLED: "false",
      STARTUP_HEALTH_STRICT: "false",
      TASK_STORE_PROVIDER: "postgres",
      TENANT_ENCRYPTION: "on",
      TENANT_KEYSTORE_DIR: path.join(tempRoot, "keystore"),
      TENANT_KMS_MASTER_KEY_FILE: path.join(tempRoot, "secrets", "master.key"),
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
      ingestJobs,
      ingestPipeline,
      worker,
      encryption,
      maintenance,
      kms,
      auditStores,
      appModule,
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
      import("../rag/ingest-job-store.js"),
      import("../rag/ingest-pipeline.js"),
      import("../rag/ingest-worker.js"),
      import("../rag/tenant-encryption.js"),
      import("../rag/tenant-encryption-maintenance.js"),
      import("../rag/kms/index.js"),
      import("../rag/admin-audit-store.js"),
      import("../app.js"),
    ]);

    modules = {
      config,
      encryption,
      ingestPipeline,
      kms,
      lifecycle,
      maintenance,
      memory,
      migrations,
      openai,
      postgres,
      rag,
      registry,
      tenant,
      vectorStore,
      worker,
    };
    config.configureEmbeddingDimensions(DIMENSIONS[MODEL_A]);
    openai.configureOpenAIProvider(embeddingProvider);
    kms.resetTenantKmsProvider();
    memory.resetSessionMemory();
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
    await tenant.runAsDatabaseSystem(async () => {
      await migrations.runPostgresMigrations();
      await registry.initializeDocumentRegistry();
    });

    const uploadsDirectory = path.join(tempRoot, "uploads");

    await mkdir(uploadsDirectory, { recursive: true });

    const app = await appModule.createApp({
      uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
      uploadsDirectory,
    });

    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    ingestJobStore = ingestJobs.createDefaultIngestJobStore();
    service = tenantLifecycle.createTenantLifecycleService({
      adminAuditService: auditStores.createDefaultAdminAuditService(),
      ingestJobStore,
      uploadsDirectory,
    });

    pdfs.alice = pdfFor(ALICE_MARKER);
    pdfs.bob = pdfFor(BOB_MARKER);
    documents.alice = await upload(TOKENS.alice, "alice-handbook", pdfs.alice);
    documents.bob = await upload(TOKENS.bob, "bob-handbook", pdfs.bob);
  });

  after(async () => {
    try {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      modules?.vectorStore.resetVectorStore();
      modules?.kms.resetTenantKmsProvider();
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

  test("uploads of two tenants rest as envelopes; the hash and size are the plaintext's", async () => {
    for (const [name, marker] of [["alice", ALICE_MARKER], ["bob", BOB_MARKER]]) {
      const row = await storedRow(documents[name]);

      assert.ok(modules.encryption.isTenantEnvelope(row.file_bytes), `${name}'s row holds an envelope`);
      assert.equal(row.file_bytes.includes(Buffer.from(marker)), false, `no ${marker} in the stored bytes`);
      assert.equal(row.file_bytes.includes(Buffer.from("%PDF")), false);
      assert.equal(row.content_sha256, createHash("sha256").update(pdfs[name]).digest("hex"));
    }

    const sizes = (await raw(`SELECT doc_id, file_size FROM rag_documents ORDER BY doc_id`)).rows;

    assert.ok(sizes.every((row) => [pdfs.alice.length, pdfs.bob.length].includes(Number(row.file_size))));
    assert.notEqual(
      modules.encryption.describeTenantEnvelope((await storedRow(documents.alice)).file_bytes).keyId,
      modules.encryption.describeTenantEnvelope((await storedRow(documents.bob)).file_bytes).keyId,
      "one key per workspace"
    );
  });

  test("download and /chat see the plaintext; the other tenant sees nothing", async () => {
    const download = await request(`/documents/${documents.alice}/file`, { token: TOKENS.alice });

    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, pdfs.alice);
    assert.equal((await request(`/documents/${documents.alice}/file`, { token: TOKENS.bob })).status, 404);

    const chat = await request("/chat", {
      body: {
        docIds: [documents.alice],
        question: `What does the ${ALICE_MARKER} policy need?`,
        sessionId: `enc-it-${suffix}`,
      },
      method: "POST",
      token: TOKENS.alice,
    });

    assert.equal(chat.status, 200, chat.bytes.toString("utf8").slice(0, 2000));
    assert.match(JSON.stringify(chat.json), /manager approval/);
  });

  test("a trashed document keeps its envelope and a restore parses the decrypted bytes", async () => {
    const marker = "gamma-ibis";
    const bytes = pdfFor(marker);
    const docId = await upload(TOKENS.alice, "alice-annex", bytes);

    assert.equal((await request(`/documents/${docId}`, { method: "DELETE", token: TOKENS.alice })).status, 200);

    const trashedRow = await storedRow(docId);
    const deletedAt = async () =>
      (await raw(`SELECT deleted_at FROM rag_documents WHERE doc_id = $1`, [docId])).rows[0]?.deleted_at ?? null;

    assert.ok(await deletedAt(), "the row stays, in the trash");
    assert.ok(modules.encryption.isTenantEnvelope(trashedRow.file_bytes), "still an envelope in the trash");
    assert.equal((await raw(`SELECT count(*)::int AS n FROM rag_document_chunks WHERE doc_id = $1`, [docId])).rows[0].n, 0);

    const trash = await request("/documents/trash", { token: TOKENS.alice });

    assert.equal(trash.status, 200);
    assert.ok(JSON.stringify(trash.json).includes(docId));
    assert.equal(JSON.stringify((await request("/documents/trash", { token: TOKENS.bob })).json).includes(docId), false);
    assert.equal((await request(`/documents/${docId}/restore`, { method: "POST", token: TOKENS.bob })).status, 404);

    const restored = await request(`/documents/${docId}/restore`, { method: "POST", token: TOKENS.alice });

    assert.equal(restored.status, 200, restored.bytes.toString("utf8").slice(0, 2000));

    const restoredRow = await storedRow(docId);

    assert.equal(await deletedAt(), null);
    assert.ok(modules.encryption.isTenantEnvelope(restoredRow.file_bytes));
    assert.ok((await raw(`SELECT count(*)::int AS n FROM rag_document_chunks WHERE doc_id = $1`, [docId])).rows[0].n > 0);
    assert.deepEqual((await request(`/documents/${docId}/file`, { token: TOKENS.alice })).bytes, bytes);

    const chat = await request("/chat", {
      body: { docIds: [docId], question: `What does the ${marker} policy need?`, sessionId: `enc-trash-${suffix}` },
      method: "POST",
      token: TOKENS.alice,
    });

    assert.equal(chat.status, 200, chat.bytes.toString("utf8").slice(0, 2000));
    assert.match(JSON.stringify(chat.json), /manager approval/);
  });

  test("a ciphertext moved into the other tenant's row fails closed", async () => {
    const bobRow = await storedRow(documents.bob);
    const aliceRow = await storedRow(documents.alice);

    await raw(`UPDATE rag_documents SET file_bytes = $2 WHERE doc_id = $1`, [documents.bob, aliceRow.file_bytes]);

    try {
      const answer = await request(`/documents/${documents.bob}/file`, { token: TOKENS.bob });

      assert.equal(answer.status, 500);
      assert.equal(answer.bytes.includes(Buffer.from(ALICE_MARKER)), false, "never the other tenant's plaintext");
      await assert.rejects(
        modules.tenant.runAsDatabaseSystem(() => modules.registry.getDocumentFile(documents.bob)),
        { code: modules.kms.TENANT_ENCRYPTION_ERROR_CODES.envelopeKeyMismatch }
      );
    } finally {
      await raw(`UPDATE rag_documents SET file_bytes = $2 WHERE doc_id = $1`, [documents.bob, bobRow.file_bytes]);
    }

    assert.deepEqual((await request(`/documents/${documents.bob}/file`, { token: TOKENS.bob })).bytes, pdfs.bob);
  });

  test("the staged ingest worker stores every output as an envelope and indexes the plaintext", async () => {
    const bytes = pdfFor(`${ALICE_MARKER}-async`);
    const docId = `doc-async-${suffix}`;
    const job = await modules.tenant.runWithDatabaseTenant(ALICE, () =>
      ingestJobStore.enqueue({ docId, fileBytes: bytes, fileName: "async.pdf", ownerUserId: ALICE.userId, workspaceId: ALICE.workspaceId })
    );
    const queued = (await raw(`SELECT file_bytes FROM rag_ingest_jobs WHERE job_id = $1`, [job.jobId])).rows[0];

    assert.ok(modules.encryption.isTenantEnvelope(queued.file_bytes));
    assert.equal(queued.file_bytes.includes(Buffer.from(ALICE_MARKER)), false);

    const outputsSeen = {};
    const ingestWorker = modules.worker.createIngestWorker({
      hooks: {
        afterStage: async ({ stage }) => {
          for (const row of (await raw(`SELECT output, payload FROM rag_ingest_jobs_outputs WHERE job_id = $1`, [job.jobId])).rows) {
            outputsSeen[row.output] = row.payload;
          }

          outputsSeen[`after:${stage}`] = true;
        },
      },
      leaseMs: 60000,
      logger: { error() {}, log() {}, warn() {} },
      pipeline: modules.ingestPipeline.getDefaultIngestPipeline(),
      retryDelayMs: () => 0,
      settleRetryDelayMs: 1,
      store: ingestJobStore,
      tempDirectory: tempRoot,
      workerId: `enc-it-${suffix}`,
    });

    assert.deepEqual(await ingestWorker.runOnce(), { jobId: job.jobId, outcome: "succeeded" });

    for (const output of ["document_file", "pages", "chunks", "embeddings"]) {
      assert.ok(modules.encryption.isTenantEnvelope(outputsSeen[output]), `${output} was stored as an envelope`);
      assert.equal(outputsSeen[output].includes(Buffer.from(ALICE_MARKER)), false, `no plaintext in ${output}`);
    }

    const committed = await storedRow(docId);

    assert.ok(modules.encryption.isTenantEnvelope(committed.file_bytes));
    assert.equal(committed.content_sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(
      Number((await raw(`SELECT COUNT(*)::int AS n FROM rag_document_chunks WHERE doc_id = $1`, [docId])).rows[0].n) > 0,
      "the worker parsed and indexed the plaintext"
    );
    assert.deepEqual((await request(`/documents/${docId}/file`, { token: TOKENS.alice })).bytes, bytes);
    documents.aliceAsync = docId;
  });

  test("an index-version build parses the decrypted bytes", async () => {
    const build = await modules.tenant.runAsDatabaseSystem(() =>
      modules.lifecycle.startIndexVersionBuild({
        builderId: `enc-it-${suffix}`,
        space: modules.lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
      })
    );
    const table = (await raw(`SELECT chunk_table FROM rag_index_versions WHERE version_id = $1`, [build.versionId])).rows[0]
      .chunk_table;
    const chunks = (await raw(`SELECT doc_id, content FROM ${table}`)).rows;

    assert.equal(build.failed, 0, JSON.stringify(build));
    assert.ok(build.indexed >= 3, JSON.stringify(build));
    assert.ok(chunks.some((row) => row.doc_id === documents.alice && row.content.includes(ALICE_MARKER)));
    assert.ok(chunks.some((row) => row.doc_id === documents.bob && row.content.includes(BOB_MARKER)));
  });

  test("encrypt-existing turns a legacy plaintext row into an envelope; rewrap moves it to a rotated key", async () => {
    const legacyBytes = pdfFor(`${BOB_MARKER}-legacy`);

    process.env.TENANT_ENCRYPTION = "off";

    try {
      documents.bobLegacy = await upload(TOKENS.bob, "bob-legacy", legacyBytes);
    } finally {
      process.env.TENANT_ENCRYPTION = "on";
    }

    const legacy = await storedRow(documents.bobLegacy);

    assert.deepEqual(legacy.file_bytes, legacyBytes, "written as plaintext while the setting was off");

    const counted = await modules.maintenance.countTenantFileEncryption();

    assert.equal(counted.documents.plaintext, 1);

    const preview = await modules.maintenance.encryptExistingTenantFiles();

    assert.equal(preview.tables.documents.changed, 1);
    assert.deepEqual((await storedRow(documents.bobLegacy)).file_bytes, legacyBytes, "a dry run writes nothing");

    const applied = await modules.maintenance.encryptExistingTenantFiles({ apply: true });

    assert.equal(applied.tables.documents.changed, 1);

    const encrypted = await storedRow(documents.bobLegacy);

    assert.ok(modules.encryption.isTenantEnvelope(encrypted.file_bytes));
    assert.equal(encrypted.file_bytes.includes(Buffer.from(BOB_MARKER)), false);
    assert.equal(encrypted.content_sha256, legacy.content_sha256);
    assert.deepEqual((await request(`/documents/${documents.bobLegacy}/file`, { token: TOKENS.bob })).bytes, legacyBytes);
    assert.equal((await modules.maintenance.countTenantFileEncryption()).documents.plaintext, 0);

    const bobScope = modules.kms.resolveTenantKeyScope(BOB);

    assert.equal((await modules.kms.getTenantKmsProvider().rotateKey(bobScope)).version, 2);

    const rewrapped = await modules.maintenance.rewrapTenantFiles({ apply: true });

    assert.equal(rewrapped.tables.documents.changed, 2, "bob's two documents; alice's are on their current version");

    for (const docId of [documents.bob, documents.bobLegacy]) {
      const row = await storedRow(docId);

      assert.equal(modules.encryption.describeTenantEnvelope(row.file_bytes).version, 2);
    }

    assert.deepEqual((await request(`/documents/${documents.bob}/file`, { token: TOKENS.bob })).bytes, pdfs.bob);
  });

  test("a value that only begins with the magic is counted malformed, never encrypted, and the export marks it and goes on", async () => {
    const forgedId = await upload(TOKENS.bob, "bob-forged", pdfFor(`${BOB_MARKER}-forged`));
    const before = await modules.maintenance.countTenantFileEncryption();

    // As an upload from before the upload checks stored it: a PDF with the
    // envelope magic and version in front, which no read can decrypt.
    await raw(
      `UPDATE rag_documents SET file_bytes = decode('00415254454e4301', 'hex') || convert_to('%PDF-1.4 forged', 'UTF8') WHERE doc_id = $1`,
      [forgedId]
    );

    try {
      const counted = await modules.maintenance.countTenantFileEncryption();

      assert.equal(counted.documents.malformed, 1);
      assert.equal(counted.documents.encrypted, before.documents.encrypted - 1, "no longer counted as an envelope");

      const preview = await modules.maintenance.encryptExistingTenantFiles();

      assert.equal(preview.tables.documents.malformed, 1);
      assert.equal(preview.tables.documents.changed, 0, "encrypt-existing leaves it alone");

      const lines = [];

      await modules.tenant.runAsDatabaseSystem(async () => {
        for await (const line of service.exportTenant({ ...BOB, actor: { userId: "ops" } })) {
          lines.push(JSON.parse(line));
        }
      });

      const forged = lines.find((line) => line.table === "documents" && line.record.doc_id === forgedId);

      assert.equal(lines.some((line) => line.type === "error"), false, JSON.stringify(lines.filter((line) => line.type === "error")));
      assert.equal(forged.record.file_bytes, null);
      assert.deepEqual(forged.record.unreadableBytes, { file_bytes: "TENANT_ENVELOPE_MALFORMED" });
      assert.deepEqual(lines.at(-1).unreadableRecords, { documents: 1 });
      assert.equal(lines.at(-1).status, "partial");
      assert.ok(
        lines.some((line) => line.table === "documents" && line.record.doc_id === documents.bob && line.record.file_bytes?.base64),
        "bob's other documents are still exported"
      );
    } finally {
      await raw(`DELETE FROM rag_documents WHERE doc_id = $1`, [forgedId]);
    }
  });

  test("the export holds the plaintext of the tenant's files", async () => {
    const lines = [];

    await modules.tenant.runAsDatabaseSystem(async () => {
      for await (const line of service.exportTenant({ ...ALICE, actor: { userId: "ops" } })) {
        lines.push(JSON.parse(line));
      }
    });

    assert.equal(lines.at(-1).type, "summary", JSON.stringify(lines).slice(0, 2000));

    const exported = lines.filter((line) => line.table === "documents" && line.record.file_bytes?.base64);
    const decoded = exported.map((line) => Buffer.from(line.record.file_bytes.base64, "base64"));

    assert.ok(decoded.some((bytes) => bytes.equals(pdfs.alice)), "the exported bytes are the uploaded PDF");
    assert.ok(decoded.every((bytes) => !modules.encryption.isTenantEnvelope(bytes)));
    assert.equal(JSON.stringify(lines).includes(BOB_MARKER), false);
  });

  test("a workspace erase destroys its key: a restored copy of its row stays unreadable, the other tenant reads on", async () => {
    // The "backup": alice's row as the database held it before the erase.
    const backup = (await raw(`SELECT * FROM rag_documents WHERE doc_id = $1`, [documents.alice])).rows[0];
    const aliceKeyId = modules.kms.resolveTenantKeyScope(ALICE).keyId;
    const preview = await service.eraseTenant({ workspaceId: ALICE.workspaceId });

    assert.equal(preview.tenantKeys.status, "dry_run");
    assert.deepEqual(preview.tenantKeys.destroy.map((key) => key.keyId), [aliceKeyId]);

    const erased = await service.eraseTenant({
      actor: { userId: "ops" },
      dryRun: false,
      force: true,
      permissionId: "admin.tenants.erase",
      workspaceId: ALICE.workspaceId,
    });

    assert.ok(["completed", "partial"].includes(erased.status), JSON.stringify(erased));
    assert.equal(erased.tenantKeys.status, "destroyed");
    assert.deepEqual(
      erased.tenantKeys.destroyed.map(({ destroyedVersions, keyId }) => ({ destroyedVersions, keyId })),
      [{ destroyedVersions: [1], keyId: aliceKeyId }]
    );
    assert.equal(Number((await raw(`SELECT COUNT(*)::int AS n FROM rag_documents WHERE workspace_id = $1`, [ALICE.workspaceId])).rows[0].n), 0);

    const tombstone = (
      await raw(`SELECT details FROM rag_admin_audit_events WHERE event_type = 'admin.tenant.erased' ORDER BY created_at DESC LIMIT 1`)
    ).rows[0];

    assert.deepEqual(tombstone.details.tenantKeys, {
      destroyed: [{ keyId: aliceKeyId, versions: [1] }],
      kept: [],
      status: "destroyed",
    });
    assert.equal(JSON.stringify(tombstone.details).includes("wrapped"), false);

    // Put the backup back: its bytes are still there, and still unreadable.
    const columns = Object.keys(backup);

    await raw(
      `INSERT INTO rag_documents (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      columns.map((column) => backup[column])
    );
    await assert.rejects(
      modules.tenant.runAsDatabaseSystem(() => modules.registry.getDocumentFile(documents.alice)),
      { code: modules.kms.TENANT_ENCRYPTION_ERROR_CODES.keyDestroyed }
    );
    await assert.rejects(
      modules.encryption.decryptTenantBytes(
        backup.file_bytes,
        modules.encryption.documentFileContext({ docId: documents.alice, ...ALICE })
      ),
      { code: modules.kms.TENANT_ENCRYPTION_ERROR_CODES.keyDestroyed }
    );

    // Bob is untouched.
    assert.deepEqual((await request(`/documents/${documents.bob}/file`, { token: TOKENS.bob })).bytes, pdfs.bob);
    assert.equal((await modules.kms.getTenantKmsProvider().describeKey(modules.kms.resolveTenantKeyScope(BOB))).state, "active");

    const chat = await request("/chat", {
      body: { docIds: [documents.bob], question: `What does the ${BOB_MARKER} policy need?`, sessionId: `enc-it-bob-${suffix}` },
      method: "POST",
      token: TOKENS.bob,
    });

    assert.equal(chat.status, 200);
    assert.match(JSON.stringify(chat.json), /manager approval/);
  });
}
