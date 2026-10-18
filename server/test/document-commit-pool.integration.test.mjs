import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// One document write needs exactly one pooled connection (rag/index.js
// commitDocument and the delete, trash and restore paths).
//
// Before the fix a write held one connection (the write transaction, or the
// content-hash lock's transaction on a non-transactional index with the
// PostgreSQL registry) and then asked the pool for a second one: the
// registration of the local / Qdrant path, the pointer re-read of the pgvector
// schema check once RAG_INDEX_VERSION_POINTER_TTL_MS had passed, the registry
// map's first load, the delete's scope check. With as many concurrent writes
// as POSTGRES_POOL_MAX every connection was held by a write waiting for
// another, and with POSTGRES_CONNECTION_TIMEOUT_MS=0 (the default) they waited
// forever. Here the pool has two connections and six writes run at once, in
// different tenants (no in-process lock serializes them) and in one tenant
// with identical bytes (the deduplicated path); each round must finish within
// the deadline. A pointer TTL of 1 ms makes every write cross the TTL, and a
// storage quota adds its advisory lock.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. It provisions its own database owned
// by a non-superuser login and drops everything after.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

const MODEL = "commit-pool-it-embed";
const DIMENSIONS = 3;
const CONCURRENCY = 6;
const DEADLINE_MS = 30_000;
const SCOPES = Array.from({ length: CONCURRENCY }, (_, index) =>
  Object.freeze({ userId: `user-${index}`, workspaceId: `ws-${index}` })
);

const embeddingProvider = {
  completeText: async () => "unused [Source 1]",
  embedQuery: async () => [1, 0, 0.1],
  embedTexts: async (texts) => texts.map(() => [1, 0, 0.1]),
};

// Rejects when `work` has not settled by the deadline: a pool deadlock never
// settles, and the test must fail rather than hang.
const withinDeadline = (label, work) => {
  let timer;

  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} did not finish within ${DEADLINE_MS} ms (pool exhausted?)`)),
        DEADLINE_MS
      );
    }),
  ]);
};

if (!adminDatabaseUrl) {
  test("document commit connection pool integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `commit_pool_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `commit_pool_it_tenant_${suffix}`;
  const systemRole = `commit_pool_it_system_${suffix}`;
  const databaseName = `commit_pool_it_${suffix}`;
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

  const originalEnv = new Map();
  const setEnv = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (!originalEnv.has(key)) {
        originalEnv.set(key, process.env[key]);
      }

      process.env[key] = value;
    }
  };

  let modules;
  let tempRoot;
  let pdfCounter = 0;

  const q = (sql, values = []) => modules.postgres.queryPostgres(sql, values);
  const writePdf = async (text) => {
    pdfCounter += 1;
    const filePath = path.join(tempRoot, `upload-${pdfCounter}.pdf`);

    await writeFile(filePath, buildTextPdf({ pages: [[text]] }));
    return filePath;
  };
  const ingest = (scope, docId, filePath, { deduplicate = true } = {}) =>
    modules.tenant.runWithDatabaseTenant(scope, () =>
      modules.rag.ingestDocument({
        deduplicate,
        docId,
        fileName: `${docId}.pdf`,
        filePath,
        ownerUserId: scope.userId,
        workspaceId: scope.workspaceId,
      })
    );
  const asTenant = (scope, work) => modules.tenant.runWithDatabaseTenant(scope, work);
  const countDocuments = async (prefix) =>
    Number(
      (await q(`SELECT COUNT(*)::int AS n FROM rag_documents WHERE doc_id LIKE $1 AND deleted_at IS NULL`, [`${prefix}%`]))
        .rows[0].n
    );
  // A fresh process: nothing cached, so the first writes load the registry
  // map and verify the schema themselves.
  const freshProcessState = async () => {
    await modules.registry.resetDocumentRegistryStore();
    modules.vectorStore.resetVectorStore();
  };

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "commit-pool-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    setEnv({
      LONG_MEMORY_DATABASE_URL: "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "commit-pool-it-key",
      OPENAI_EMBEDDING_MODEL: MODEL,
      PDF_PARSER: "pdfjs",
      POSTGRES_CONNECTION_TIMEOUT_MS: "0",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, {
        password: ownerPassword,
        user: ownerRole,
      }),
      POSTGRES_POOL_MAX: "2",
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_SYSTEM_ROLE: systemRole,
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_DATA_DIRECTORY: tempRoot,
      RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      RAG_HYBRID_ENABLED: "true",
      RAG_INDEX_VERSION_POINTER_TTL_MS: "1",
      RAG_INGEST_DEDUP: "true",
      RAG_LONG_MEMORY_ENABLED: "false",
      TENANT_MAX_DOCUMENTS: "1000",
      VECTOR_STORE_PROVIDER: "pgvector",
    });

    const [config, postgres, tenant, migrations, registry, rag, openai, vectorStore] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/postgres-tenant.js"),
      import("../rag/db-migrations.js"),
      import("../rag/doc-registry.js"),
      import("../rag/index.js"),
      import("../rag/openai.js"),
      import("../rag/vector-store.js"),
    ]);

    modules = { config, migrations, openai, postgres, rag, registry, tenant, vectorStore };
    config.configureEmbeddingDimensions(DIMENSIONS);
    openai.configureOpenAIProvider(embeddingProvider);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await migrations.runPostgresMigrations();
  });

  after(async () => {
    try {
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

  describe("pgvector (the write transaction holds the connection)", () => {
    before(async () => {
      setEnv({ VECTOR_STORE_PROVIDER: "pgvector" });
      await freshProcessState();
    });

    test(`${CONCURRENCY} concurrent uploads in ${CONCURRENCY} tenants finish on a pool of 2`, async () => {
      const files = await Promise.all(SCOPES.map((scope) => writePdf(`Policy text of ${scope.userId}.`)));
      const results = await withinDeadline(
        "the uploads",
        Promise.all(SCOPES.map((scope, index) => ingest(scope, `pg-doc-${index}`, files[index])))
      );

      assert.deepEqual(results.map((document) => document.docId), SCOPES.map((_, index) => `pg-doc-${index}`));
      assert.equal(await countDocuments("pg-doc-"), CONCURRENCY);
    });

    test(`${CONCURRENCY} concurrent uploads of identical bytes in one tenant end as one document`, async () => {
      const file = await writePdf("The identical bytes of one tenant.");
      const results = await withinDeadline(
        "the deduplicated uploads",
        Promise.all(SCOPES.map((_, index) => ingest(SCOPES[0], `pg-dup-${index}`, file)))
      );
      const created = results.filter((document) => document.duplicate !== true);

      assert.equal(created.length, 1);
      assert.equal(new Set(results.map((document) => document.docId)).size, 1);
      assert.equal(await countDocuments("pg-dup-"), 1);
    });

    test(`${CONCURRENCY} concurrent deletes finish on a pool of 2`, async () => {
      const deleted = await withinDeadline(
        "the deletes",
        Promise.all(
          SCOPES.map((scope, index) => asTenant(scope, () => modules.rag.deleteDocument(`pg-doc-${index}`, { accessScope: scope })))
        )
      );

      assert.equal(deleted.filter(Boolean).length, CONCURRENCY);
      assert.equal(await countDocuments("pg-doc-"), 0);
    });

    test(`${CONCURRENCY} concurrent moves into the trash and restores finish on a pool of 2`, async () => {
      setEnv({ DOCUMENT_TRASH_RETENTION_HOURS: "24" });

      try {
        const files = await Promise.all(SCOPES.map((scope) => writePdf(`Trash text of ${scope.userId}.`)));

        await withinDeadline(
          "the uploads",
          Promise.all(SCOPES.map((scope, index) => ingest(scope, `pg-trash-${index}`, files[index])))
        );

        const trashed = await withinDeadline(
          "the moves into the trash",
          Promise.all(
            SCOPES.map((scope, index) =>
              asTenant(scope, () => modules.rag.deleteDocument(`pg-trash-${index}`, { accessScope: scope }))
            )
          )
        );

        assert.equal(trashed.filter(Boolean).length, CONCURRENCY);
        assert.equal(await countDocuments("pg-trash-"), 0);

        const restored = await withinDeadline(
          "the restores",
          Promise.all(
            SCOPES.map((scope, index) =>
              asTenant(scope, () => modules.rag.restoreDocument({ accessScope: scope, docId: `pg-trash-${index}` }))
            )
          )
        );

        assert.deepEqual(restored.map((document) => document?.version), SCOPES.map(() => 2));
        assert.equal(await countDocuments("pg-trash-"), CONCURRENCY);
      } finally {
        setEnv({ DOCUMENT_TRASH_RETENTION_HOURS: "0" });
      }
    });
  });

  describe("local index with the PostgreSQL registry (the content-hash lock holds the connection)", () => {
    before(async () => {
      setEnv({ VECTOR_STORE_PROVIDER: "local" });
      await freshProcessState();
    });

    after(() => {
      setEnv({ VECTOR_STORE_PROVIDER: "pgvector" });
    });

    test(`${CONCURRENCY} concurrent deduplicated uploads in ${CONCURRENCY} tenants finish on a pool of 2`, async () => {
      const files = await Promise.all(SCOPES.map((scope) => writePdf(`Local policy text of ${scope.userId}.`)));
      const results = await withinDeadline(
        "the uploads",
        Promise.all(SCOPES.map((scope, index) => ingest(scope, `local-doc-${index}`, files[index])))
      );

      assert.deepEqual(results.map((document) => document.docId), SCOPES.map((_, index) => `local-doc-${index}`));
      assert.equal(await countDocuments("local-doc-"), CONCURRENCY);
    });

    test(`${CONCURRENCY} concurrent uploads of identical bytes in one tenant end as one document`, async () => {
      const file = await writePdf("The identical local bytes of one tenant.");
      const results = await withinDeadline(
        "the deduplicated uploads",
        Promise.all(SCOPES.map((_, index) => ingest(SCOPES[0], `local-dup-${index}`, file)))
      );

      assert.equal(new Set(results.map((document) => document.docId)).size, 1);
      assert.equal(await countDocuments("local-dup-"), 1);
    });

    test(`${CONCURRENCY} concurrent deletes finish on a pool of 2`, async () => {
      const deleted = await withinDeadline(
        "the deletes",
        Promise.all(
          SCOPES.map((scope, index) =>
            asTenant(scope, () => modules.rag.deleteDocument(`local-doc-${index}`, { accessScope: scope }))
          )
        )
      );

      assert.equal(deleted.filter(Boolean).length, CONCURRENCY);
      assert.equal(await countDocuments("local-doc-"), 0);
    });
  });
}
