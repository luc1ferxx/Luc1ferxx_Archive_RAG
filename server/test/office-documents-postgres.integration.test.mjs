import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildDocx, buildXlsx } from "./office-fixture-builder.mjs";

// Word, PowerPoint and Excel documents through the real app on a real
// PostgreSQL with pgvector, the PostgreSQL document registry and row-level
// security enforced:
//
// * a synchronous upload of a .docx registers its MIME type and writes chunks
//   that carry their section and the document's own chunk profile; the
//   download sends its type as an attachment;
// * the trash restore re-parses the stored bytes as the format the document
//   was registered as (also once RAG_DOCUMENT_FORMATS leaves Word out), keeps
//   its MIME type and writes its located chunks under the next content
//   version;
// * PUT /documents/:docId records the type of the content it writes: a Word
//   document replaced by a workbook becomes one (sheets), then by a PDF a PDF
//   again (no location, inline download).
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. It provisions its own database owned
// by a non-superuser login and drops everything after.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

const MODEL = "office-documents-it-embed";
const DIMENSIONS = 4;
const ALICE = Object.freeze({ userId: "alice", workspaceId: "ws-a" });
const AS_ALICE = { "x-api-key": "alice-token" };
const MIME = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

const embedFor = (text) => {
  const lower = String(text).toLowerCase();

  return [lower.includes("contract") ? 1 : 0, lower.includes("budget") ? 1 : 0, lower.includes("policy") ? 1 : 0, 0.05];
};

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const DOCX = buildDocx({
  blocks: [
    { heading: 1, text: "Retention" },
    { text: "Signed contracts are kept for seven years after they end." },
    { heading: 1, text: "Approval" },
    { text: "Two managers approve every contract change." },
  ],
});
const XLSX = buildXlsx({
  sheets: [
    { name: "Budget", rows: [["Item", "Amount"], ["Travel budget", 1200]] },
    { name: "Staff", rows: [["Name", "Role"], ["Ana", "Lead"]] },
  ],
});
const PDF = buildTextPdf({ pages: [["The travel policy needs manager approval."]] });

if (!adminDatabaseUrl) {
  test("Office documents PostgreSQL integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `office_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `office_it_tenant_${suffix}`;
  const systemRole = `office_it_system_${suffix}`;
  const databaseName = `office_it_${suffix}`;
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
    AGENT_RUN_STORE_PROVIDER: "postgres",
    API_AUTH_ENABLED: "true",
    API_AUTH_TOKENS: JSON.stringify({ "alice-token": ALICE }),
    DOCUMENT_TRASH_RETENTION_HOURS: "24",
    LONG_MEMORY_DATABASE_URL: "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "office-documents-it-key",
    OPENAI_EMBEDDING_MODEL: MODEL,
    PDF_PARSER: "pdfjs",
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_SYSTEM_ROLE: systemRole,
    POSTGRES_TENANT_ROLE: tenantRole,
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_DOCUMENT_FORMATS: "",
    RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    RAG_HYBRID_ENABLED: "true",
    RAG_INGEST_DEDUP: "false",
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
  let docId;
  const originalEnv = new Map();

  const q = (sql, values = []) => modules.postgres.queryPostgres(sql, values);
  const send = async (method, requestPath, { bytes, fileName, type }) => {
    const form = new FormData();

    form.append("file", new Blob([bytes], { type }), fileName);

    const response = await fetch(`${baseUrl}${requestPath}`, { body: form, headers: AS_ALICE, method });

    return { json: await response.json(), status: response.status };
  };
  const call = async (method, requestPath) => {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      body: method === "POST" ? "{}" : undefined,
      headers: { ...AS_ALICE, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      method,
    });
    const text = await response.text();

    return { json: text ? JSON.parse(text) : null, status: response.status, text };
  };
  const documentRow = async () =>
    (await q(`SELECT mime_type, content_version, deleted_at FROM rag_documents WHERE doc_id = $1`, [docId])).rows[0] ?? null;
  const chunkMetadata = async () =>
    (await q(`SELECT metadata FROM rag_document_chunks WHERE doc_id = $1 ORDER BY chunk_index`, [docId])).rows.map(
      (row) => (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata)
    );
  const locationsOf = (metadata) =>
    [...new Map(metadata.map((entry) => [entry.pageNumber, [entry.pageNumber, entry.locationUnit, entry.locationLabel]])).values()];
  const officeProfileId = async (format) => {
    const extractor =
      format === "docx"
        ? { extractor: "mammoth", extractorVersion: (await import("../rag/office/docx-loader.js")).getMammothVersion() }
        : { extractor: "sheetjs", extractorVersion: (await import("../rag/office/xlsx-loader.js")).getSheetjsVersion() };

    return modules.chunkProfile.describeChunkProfile({ format, ...extractor }).id;
  };
  const download = async () => {
    const response = await fetch(`${baseUrl}/documents/${docId}/file`, { headers: AS_ALICE });

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      disposition: response.headers.get("content-disposition"),
      status: response.status,
      type: response.headers.get("content-type"),
    };
  };

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "office-documents-it-"));

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

    const [config, postgres, migrations, registry, openai, vectorStore, appModule, chunkProfile] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/db-migrations.js"),
      import("../rag/doc-registry.js"),
      import("../rag/openai.js"),
      import("../rag/vector-store.js"),
      import("../app.js"),
      import("../rag/chunk-profile.js"),
    ]);

    modules = { chunkProfile, config, migrations, openai, postgres, registry, vectorStore };
    config.configureEmbeddingDimensions(DIMENSIONS);
    openai.configureOpenAIProvider({
      completeText: async () => "unused [Source 1]",
      embedQuery: async (query) => embedFor(query),
      embedTexts: async (texts) => texts.map((text) => embedFor(text)),
    });
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

  test("a synchronous upload registers a Word document's MIME type and writes its located chunks", async () => {
    const created = await send("POST", "/upload", { bytes: DOCX, fileName: "retention.docx", type: MIME.docx });

    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.mimeType, MIME.docx);
    docId = created.json.docId;

    assert.equal((await documentRow()).mime_type, MIME.docx);

    const metadata = await chunkMetadata();
    const profileId = await officeProfileId("docx");

    assert.deepEqual(locationsOf(metadata), [
      [1, "section", "Retention"],
      [2, "section", "Approval"],
    ]);
    assert.ok(metadata.every((entry) => entry.chunkProfileId === profileId));

    const file = await download();

    assert.equal(file.status, 200);
    assert.equal(file.type, MIME.docx);
    assert.equal(file.disposition, "attachment; filename*=UTF-8''retention.docx");
    assert.deepEqual(file.bytes, DOCX);
  });

  test("the trash restore re-parses a stored Word document as Word, even once uploads leave Word out", async () => {
    assert.equal((await call("DELETE", `/documents/${docId}`)).status, 200);
    assert.ok((await documentRow()).deleted_at);
    assert.equal((await chunkMetadata()).length, 0);

    process.env.RAG_DOCUMENT_FORMATS = "pdf";

    try {
      const restored = await call("POST", `/documents/${docId}/restore`);

      assert.equal(restored.status, 200, restored.text);
      assert.equal(restored.json.document.mimeType, MIME.docx);
      assert.equal(restored.json.document.version, 2);
    } finally {
      process.env.RAG_DOCUMENT_FORMATS = "";
    }

    const row = await documentRow();
    const metadata = await chunkMetadata();

    assert.equal(row.deleted_at, null);
    assert.equal(row.mime_type, MIME.docx);
    assert.equal(Number(row.content_version), 2);
    assert.deepEqual(locationsOf(metadata), [
      [1, "section", "Retention"],
      [2, "section", "Approval"],
    ]);
    assert.ok(metadata.every((entry) => entry.documentVersion === 2));

    const profileId = await officeProfileId("docx");

    assert.ok(metadata.every((entry) => entry.chunkProfileId === profileId));
  });

  test("a replacement records the type of its own content: Word, then a workbook, then a PDF", async () => {
    const toSheet = await send("PUT", `/documents/${docId}`, { bytes: XLSX, fileName: "budget.xlsx", type: MIME.xlsx });

    assert.equal(toSheet.status, 200, JSON.stringify(toSheet.json));
    assert.equal(toSheet.json.mimeType, MIME.xlsx);
    assert.equal((await documentRow()).mime_type, MIME.xlsx);

    const sheetChunks = await chunkMetadata();
    const sheetProfileId = await officeProfileId("xlsx");

    assert.deepEqual(locationsOf(sheetChunks), [
      [1, "sheet", "Budget"],
      [2, "sheet", "Staff"],
    ]);
    assert.ok(sheetChunks.every((entry) => entry.chunkProfileId === sheetProfileId));

    let file = await download();

    assert.equal(file.type, MIME.xlsx);
    assert.equal(file.disposition, "attachment; filename*=UTF-8''budget.xlsx");

    const toPdf = await send("PUT", `/documents/${docId}`, { bytes: PDF, fileName: "travel.pdf", type: MIME.pdf });

    assert.equal(toPdf.status, 200, JSON.stringify(toPdf.json));
    assert.equal(toPdf.json.mimeType, MIME.pdf);
    assert.equal((await documentRow()).mime_type, MIME.pdf);

    const pdfChunks = await chunkMetadata();

    assert.ok(pdfChunks.length > 0);
    assert.ok(pdfChunks.every((entry) => !("locationUnit" in entry) && !("locationLabel" in entry)));
    assert.ok(pdfChunks.every((entry) => entry.chunkProfileId === modules.chunkProfile.describeChunkProfile().id));

    file = await download();
    assert.equal(file.type, MIME.pdf);
    assert.equal(file.disposition, "inline; filename*=UTF-8''travel.pdf");
  });
}
