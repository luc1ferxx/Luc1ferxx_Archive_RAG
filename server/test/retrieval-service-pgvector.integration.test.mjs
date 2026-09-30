import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// Real-database check of the retrieval tier (rag/retrieval-service/): a
// search runs as the signed caller's tenant, so PostgreSQL row-level security
// decides which chunks it can see, and another tenant's docId answers like a
// missing one. It runs only when PGVECTOR_TEST_DATABASE_URL points at a
// pgvector-enabled PostgreSQL whose login may create roles and databases
// (CI's pgvector/pgvector:pg16 service and scripts/run-pgvector-integration.sh
// both qualify); otherwise it is reported as skipped, never as passed.
//
// Like postgres-row-level-security.integration.test.mjs it provisions its own
// database owned by a non-superuser login with only CREATEROLE, so the tenant
// role and its policies are the migration's own, and drops everything after.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("retrieval service pgvector integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `retrieval_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `retrieval_it_tenant_${suffix}`;
  const databaseName = `retrieval_it_${suffix}`;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "retrieval-service-pg-it-"));
  const SECRET = "i".repeat(24) + "-integration-secret-0123456789";
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

  const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
  const BOB = { authenticated: true, userId: "bob", workspaceId: "ws-b" };
  const DIMENSIONS = 8;
  const embed = (text) => {
    const vector = new Array(DIMENSIONS).fill(0);

    for (const term of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let hash = 0;

      for (const character of term) {
        hash = (hash * 31 + character.codePointAt(0)) % (DIMENSIONS - 1);
      }

      vector[hash] += 1;
    }

    vector[DIMENSIONS - 1] = 0.05;
    return vector;
  };

  let modules;
  let server;
  let serverUrl;

  before(async () => {
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    Object.assign(process.env, {
      INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
      OPENAI_EMBEDDING_MODEL: "retrieval-it-embedding",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole }),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
      RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      RAG_HYBRID_ENABLED: "true",
      RAG_OBSERVABILITY_ENABLED: "false",
      RAG_RERANK_ENABLED: "false",
      RAG_SEMANTIC_CACHE: "off",
      VECTOR_STORE_PROVIDER: "pgvector",
    });
    delete process.env.ARCHIVE_RAG_ROLE;
    delete process.env.RETRIEVAL_SERVICE_URL;

    const [config, postgres, tenant, migrations, registry, openai, ragIndex, execution, remote, app, serviceClient, embeddingCache] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/doc-registry.js"),
        import("../rag/openai.js"),
        import("../rag/index.js"),
        import("../rag/document-rag-execution.js"),
        import("../rag/retrieval-service/remote-retrieval.js"),
        import("../rag/retrieval-service/app.js"),
        import("../rag/service-client.js"),
        import("../rag/embedding-cache.js"),
      ]);

    modules = { app, config, embeddingCache, execution, migrations, openai, postgres, ragIndex, registry, remote, serviceClient, tenant };
    config.configureEmbeddingDimensions(DIMENSIONS);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await migrations.runPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    await registry.resetDocumentRegistry();
    openai.configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async (query) => embed(query),
      embedTexts: async (texts) => texts.map(embed),
    });

    const fixtureFile = path.join(tempRoot, "fixture.pdf");

    writeFileSync(fixtureFile, "%PDF-1.4 fixture", "utf8");

    for (const [scope, docId, text] of [
      [ALICE, "doc-alice", "Alpha policy: employees receive ten paid annual leave days each year."],
      [BOB, "doc-bob", "Alpha policy: employees receive thirty paid annual leave days each year."],
    ]) {
      await ragIndex.ingestDocumentPages({
        docId,
        fileName: `${docId}.pdf`,
        filePath: fixtureFile,
        ownerUserId: scope.userId,
        pages: [{ pageNumber: 1, text }],
        workspaceId: scope.workspaceId,
      });
    }

    server = http.createServer(app.createRetrievalApp({ logger: { error() {}, log() {}, warn() {} } }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }

    modules?.openai.resetOpenAIProvider();
    modules?.serviceClient.resetServiceClients();
    await modules?.postgres.resetPostgresPool();
    await modules?.registry.resetDocumentRegistryStore();
    await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
    rmSync(tempRoot, { force: true, recursive: true });
  });

  const QUERIES = [{ id: "primary", primary: true, query: "alpha policy paid annual leave days" }];
  const useRemote = () => {
    process.env.RETRIEVAL_SERVICE_URL = serverUrl;
    modules.serviceClient.resetServiceClients();
  };
  const useInProcess = () => {
    delete process.env.RETRIEVAL_SERVICE_URL;
    modules.serviceClient.resetServiceClients();
  };

  test("row-level security alone hides another tenant's chunks from an in-process search", async () => {
    useInProcess();

    const asAlice = await modules.tenant.runWithDatabaseTenant(ALICE, () =>
      modules.execution.retrieveGlobalContextForQueriesInProcess({ docIds: ["doc-bob"], retrievalQueries: QUERIES })
    );
    const asOwner = await modules.execution.retrieveGlobalContextForQueriesInProcess({
      docIds: ["doc-bob"],
      retrievalQueries: QUERIES,
    });

    assert.deepEqual(asAlice.results, []);
    assert.ok(asOwner.results.length > 0, "the owner path sees the chunk, so the empty answer is the policy");
  });

  test("through the retrieval tier a tenant sees only its own chunks; a foreign docId answers like a missing one", async () => {
    useRemote();

    const retrieve = (accessScope, docIds) =>
      modules.remote.retrieveGlobalContextRemotely({ accessScope, docIds, retrievalQueries: QUERIES });
    const aliceBoth = await retrieve(ALICE, ["doc-alice", "doc-bob"]);
    const aliceMissing = await retrieve(ALICE, ["doc-alice", "doc-missing"]);

    assert.ok(aliceBoth.results.length > 0);
    assert.ok(aliceBoth.results.every((result) => result.document.metadata.docId === "doc-alice"));
    assert.deepStrictEqual(aliceBoth, aliceMissing);
    assert.equal(aliceBoth.retrieval.vectorStoreProvider, "pgvector");

    const bobOwn = await retrieve(BOB, ["doc-bob"]);

    assert.ok(bobOwn.results.length > 0);
    assert.ok(bobOwn.results.every((result) => result.document.metadata.docId === "doc-bob"));

    const perDocument = await modules.remote.retrievePerDocumentContextRemotely({
      accessScope: ALICE,
      docIds: ["doc-bob", "doc-alice"],
      retrievalQueries: QUERIES,
    });
    const perDocumentMissing = await modules.remote.retrievePerDocumentContextRemotely({
      accessScope: ALICE,
      docIds: ["doc-missing", "doc-alice"],
      retrievalQueries: QUERIES,
    });

    assert.deepEqual(perDocument.resultsByDocument.get("doc-bob"), []);
    assert.deepStrictEqual(perDocument.retrieval, perDocumentMissing.retrieval);
  });

  test("the retrieval tier searches as the signed tenant: row-level security holds even where the registry would admit a docId", async () => {
    const ownerUrl = process.env.POSTGRES_DATABASE_URL;
    const documentsTable = modules.config.getDocumentsPostgresTable();

    // A documents row that says Alice owns doc-bob, over chunk rows that
    // still say Bob: the registry (and so the tier's docId mask) now admits
    // doc-bob for Alice, and only the chunk policy can keep it out.
    await adminQuery(ownerUrl, `UPDATE ${documentsTable} SET owner_user_id = 'alice', workspace_id = 'ws-a' WHERE doc_id = 'doc-bob'`);
    await modules.registry.loadDocumentsFromStore(["doc-bob"]);

    try {
      const mask = await modules.app.maskInvisibleDocIds(["doc-bob"], ALICE);

      assert.equal(mask.invisibleCount, 0, "the registry admits doc-bob for Alice");

      useRemote();
      const remote = await modules.remote.retrieveGlobalContextRemotely({
        accessScope: ALICE,
        docIds: ["doc-bob"],
        retrievalQueries: QUERIES,
      });

      assert.deepEqual(remote.results, [], "the search ran as Alice, whose policy hides Bob's chunks");

      useInProcess();
      const ownerPath = await modules.execution.retrieveGlobalContextForQueriesInProcess({
        docIds: ["doc-bob"],
        retrievalQueries: QUERIES,
      });

      assert.ok(ownerPath.results.length > 0);
    } finally {
      await adminQuery(ownerUrl, `UPDATE ${documentsTable} SET owner_user_id = 'bob', workspace_id = 'ws-b' WHERE doc_id = 'doc-bob'`);
      await modules.registry.loadDocumentsFromStore(["doc-bob"]);
      useInProcess();
    }
  });

  test("the retrieval tier returns what the in-process search returns under the same tenant", async () => {
    const run = () =>
      process.env.RETRIEVAL_SERVICE_URL
        ? modules.remote.retrieveGlobalContextRemotely({ accessScope: ALICE, docIds: ["doc-alice"], retrievalQueries: QUERIES })
        : modules.tenant.runWithDatabaseTenant(ALICE, () =>
            modules.execution.retrieveGlobalContextForQueriesInProcess({ docIds: ["doc-alice"], retrievalQueries: QUERIES })
          );

    useInProcess();
    modules.embeddingCache.resetEmbeddingCache();
    const local = await run();

    useRemote();
    modules.embeddingCache.resetEmbeddingCache();
    const remote = await run();

    useInProcess();
    assert.ok(local.results.length > 0);
    assert.deepStrictEqual(remote, local);

    const health = await (await fetch(`${serverUrl}/health`)).json();

    assert.equal(health.checks.vectorStore.provider, "pgvector");
    assert.equal(health.checks.vectorStore.status, "ok", health.checks.vectorStore.message);
    assert.ok(health.checks.vectorStore.indexVersions, "index version status is reported");
  });
}
