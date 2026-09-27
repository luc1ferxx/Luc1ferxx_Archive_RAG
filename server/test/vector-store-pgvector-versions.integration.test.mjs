import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// Real-database checks for versioned pgvector indexes (migration 016,
// rag/vector-store-pgvector-versions.js and -version-lifecycle.js, the
// vector:index CLI):
//
// * the existing chunk table becomes version 1 in place on upgrade;
// * a version with another embedding model AND width builds from the stored
//   PDF bytes, with its own table, indexes, policy, grant and sparse-rank
//   function, created at runtime by a non-superuser owner;
// * an ingest during the build is dual-written, a re-ingest during the build
//   wins over the builder's older bytes, and a delete during the build is not
//   resurrected;
// * the CLI activates it in another process while tenant /chat requests and
//   searches run here, with zero errors and the switch picked up through the
//   pointer TTL alone;
// * writes during the grace period reach the old version, so a rollback loses
//   nothing; retire drops the table and function;
// * a builder process killed mid-build leaves a lease no second builder can
//   take while it is live, a scoped clear during the build reaches the
//   building table, and resume finishes only the missing documents;
// * the new table isolates tenants exactly like version 1.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. Like the row-level security suite it
// provisions its own database (the active pointer is global state no other
// suite may share) owned by a non-superuser login, and drops everything after.

const execFileAsync = promisify(execFile);
const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const childMode = process.env.INDEX_VERSIONS_IT_CHILD ?? "";

const MODEL_A = "versions-it-embed-a";
const MODEL_B = "versions-it-embed-b";
const MODEL_C = "versions-it-embed-c";
const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
const DIMENSIONS = { [MODEL_A]: TOPICS.length + 1, [MODEL_B]: 6, [MODEL_C]: 5 };
const POINTER_TTL_MS = 400;
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

// Three embedding "models" of different widths over the same topic words, so
// every version ranks the same documents first while no two versions' vectors
// are interchangeable.
const embedFor = (text, model = MODEL_A) => {
  const lower = String(text).toLowerCase();
  const hits = TOPICS.map((topic) => (new RegExp(`\\b${topic}\\b`).test(lower) ? 1 : 0));

  if (model === MODEL_B) {
    return [hits[0] + hits[5], hits[1] + hits[6], hits[2] + hits[7], hits[3] + hits[8], hits[4], 0.1];
  }

  if (model === MODEL_C) {
    return [hits[0] + hits[4] + hits[8], hits[1] + hits[5], hits[2] + hits[6], hits[3] + hits[7], 0.2];
  }

  return [...hits, 0.05];
};

const createEmbeddingProvider = (calls = { documents: [], queries: [] }) => ({
  calls,
  provider: {
    completeText: async (prompt) => {
      const sourceMatch = String(prompt).match(/\[Source 1\][^\n]*\n([^\n]+)/);

      return `${sourceMatch?.[1]?.trim() ?? "The documents describe the policy."} [Source 1]`;
    },
    embedQuery: async (query, options) => {
      const model = options?.embeddingSpace?.model ?? MODEL_A;

      calls.queries.push({ model, query });
      return embedFor(query, model);
    },
    embedTexts: async (texts, options) => {
      const model = options?.embeddingSpace?.model ?? MODEL_A;

      calls.documents.push({ count: texts.length, model, texts });
      return texts.map((text) => embedFor(text, model));
    },
  },
});

const configureEnvironment = (databaseUrl, tenantRole, dataDirectory) => {
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  process.env.LONG_MEMORY_DATABASE_URL = "";
  process.env.POSTGRES_TENANT_ROLE = tenantRole;
  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_HYBRID_FUSION = "rrf";
  process.env.RAG_LONG_MEMORY_ENABLED = "false";
  process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED = "false";
  process.env.SESSION_MEMORY_STORE_PROVIDER = "memory";
  process.env.OPENAI_EMBEDDING_MODEL = MODEL_A;
  process.env.RAG_EMBEDDING_DIMENSIONS = String(DIMENSIONS[MODEL_A]);
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "versions-it-key";
  process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = String(POINTER_TTL_MS);
  process.env.RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS = "600000";
  process.env.PDF_PARSER = "pdfjs";
  // Keeps the registry's legacy importer away from any real data directory.
  process.env.RAG_DATA_DIRECTORY = dataDirectory;
};

if (childMode === "crash-build") {
  // A builder process that dies (exit 137, no cleanup, lease kept) after it
  // committed two documents.
  const [{ configureEmbeddingDimensions }, { configureOpenAIProvider }, lifecycle] = await Promise.all([
    import("../rag/config.js"),
    import("../rag/openai.js"),
    import("../rag/vector-store-pgvector-version-lifecycle.js"),
  ]);
  let written = 0;

  configureEmbeddingDimensions(DIMENSIONS[MODEL_A]);
  configureOpenAIProvider(createEmbeddingProvider().provider);
  await lifecycle.startIndexVersionBuild({
    batchSize: 1,
    builderId: "crash-builder",
    hooks: {
      afterDocument: () => {
        written += 1;

        if (written === 2) {
          process.exit(137);
        }
      },
    },
    leaseMs: Number(process.env.INDEX_VERSIONS_IT_LEASE_MS),
    space: lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_C], model: MODEL_C }),
  });
  process.exit(1);
} else if (!adminDatabaseUrl) {
  test("pgvector index versions integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `versions_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `versions_it_tenant_${suffix}`;
  const databaseName = `versions_it_${suffix}`;
  const cliPath = fileURLToPath(new URL("../vector-index.mjs", import.meta.url));
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const embedding = createEmbeddingProvider();

  let modules;
  let tempRoot;

  // Owner statements (no tenant bound), and tenant statements under the row policies.
  const q = (sql, values = []) => modules.postgres.queryPostgres(sql, values);
  const asTenant = (scope, sql, values = []) =>
    modules.tenant.runWithDatabaseTenant(scope, () =>
      modules.postgres.withPostgresTransaction((client) => client.query(sql, values))
    );

  const chunkCounts = async (table) =>
    Object.fromEntries(
      (await q(`SELECT doc_id, COUNT(*)::int AS n FROM ${table} GROUP BY doc_id ORDER BY doc_id`)).rows.map(
        (row) => [row.doc_id, row.n]
      )
    );
  const versionRow = async (versionId) =>
    (await q(`SELECT * FROM rag_index_versions WHERE version_id = $1`, [versionId])).rows[0];
  const pointerRow = async () => (await q(`SELECT * FROM rag_index_versions_pointer`)).rows[0];

  const writePdf = async (name, sentences) => {
    const filePath = path.join(tempRoot, `${name}-${randomBytes(3).toString("hex")}.pdf`);

    await writeFile(filePath, buildTextPdf({ pages: [sentences] }));
    return filePath;
  };
  const ingest = async (scope, docId, sentences) =>
    modules.tenant.runWithDatabaseTenant(scope, async () =>
      modules.rag.ingestDocument({
        docId,
        fileName: `${docId}.pdf`,
        filePath: await writePdf(docId, sentences),
        ownerUserId: scope.userId,
        workspaceId: scope.workspaceId,
      })
    );
  const remove = (scope, docId) =>
    modules.tenant.runWithDatabaseTenant(scope, () =>
      modules.rag.deleteDocument(docId, { accessScope: scope })
    );
  const search = (scope, text, docIds, topK = 4) =>
    modules.tenant.runWithDatabaseTenant(scope, () =>
      modules.vectorStore.searchDocumentsWithRoutes({
        docIds,
        queryText: text,
        queryVector: embedFor(text, MODEL_A),
        topK,
      })
    );
  const topDocIds = (searchResult) =>
    searchResult.results.map((result) => result.document.metadata.docId);
  const queriesIn = (model) => embedding.calls.queries.filter((call) => call.model === model).length;

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "index-versions-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    // pgvector is not a trusted extension; a superuser installs it, as a DBA would.
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    configureEnvironment(
      withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole }),
      tenantRole,
      tempRoot
    );

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
      pgvector,
      versions,
      lifecycle,
      health,
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
      import("../rag/vector-store-pgvector.js"),
      import("../rag/vector-store-pgvector-versions.js"),
      import("../rag/vector-store-pgvector-version-lifecycle.js"),
      import("../health.js"),
    ]);

    modules = { config, health, lifecycle, memory, migrations, openai, pgvector, postgres, rag, registry, tenant, vectorStore, versions };
    config.configureEmbeddingDimensions(DIMENSIONS[MODEL_A]);
    openai.configureOpenAIProvider(embedding.provider);
    memory.resetSessionMemory();
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
    await migrations.runPostgresMigrations();
    await registry.initializeDocumentRegistry();
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
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("upgrading registers the existing chunk table as active version 1 without moving a row", async () => {
    await ingest(ALICE, "d-alpha", ["Alpha policy requires manager approval for remote work."]);

    const before = (await q(`SELECT chunk_id, ctid::text AS ctid FROM rag_document_chunks ORDER BY chunk_id`)).rows;

    assert.ok(before.length > 0);

    // A database from before migration 016: no registry, 016 not applied.
    await q(`DROP TABLE rag_index_versions_build_progress, rag_index_versions_pointer, rag_index_versions`);
    await q(`DELETE FROM schema_migrations WHERE id = '016_create_rag_index_versions.sql'`);
    modules.migrations.resetPostgresMigrations();
    modules.vectorStore.resetVectorStore();
    await modules.pgvector.ensurePgvectorSchema({ force: true });

    const version = await versionRow(1);
    const pointer = await pointerRow();

    assert.equal(version.status, "active");
    assert.equal(version.chunk_table, "rag_document_chunks");
    assert.equal(version.sparse_rank_function, "rag_document_chunks_sparse_rank");
    assert.equal(version.embedding_space_source, "configuration");
    assert.equal(pointer.active_version_id, 1);
    assert.equal(Number(pointer.generation), 1);
    assert.deepEqual(
      (await q(`SELECT chunk_id, ctid::text AS ctid FROM rag_document_chunks ORDER BY chunk_id`)).rows,
      before,
      "every row is where it was: nothing was copied or rewritten"
    );
    assert.deepEqual(topDocIds(await search(ALICE, "alpha approval", ["d-alpha"])).slice(0, 1), ["d-alpha"]);

    // The tenant role reads the registry and cannot change it.
    await assert.rejects(
      asTenant(ALICE, `UPDATE rag_index_versions SET status = 'retired' WHERE version_id = 1`),
      /permission denied/
    );
    await assert.rejects(
      asTenant(ALICE, `SELECT COUNT(*) FROM rag_index_versions_build_progress`),
      /permission denied/
    );
  });

  test("a version under another model and width builds beside version 1; dual writes, re-ingests and deletes during the build all land", async () => {
    await ingest(BOB, "d-beta", ["Beta budget caps meals at forty dollars per day."]);
    await ingest(BOB, "d-delta", ["Delta clause covers scoped workspace documents."]);
    await ingest(ALICE, "d-gamma", ["Gamma renewal window is twelve months after the audit."]);

    const duringBuild = {};
    const result = await modules.lifecycle.startIndexVersionBuild({
      batchSize: 2,
      builderId: "it-builder",
      hooks: {
        beforeDocumentWrite: async ({ attempt, docId, versionId }) => {
          const table = `rag_document_chunks_v${versionId}`;

          if (docId === "d-alpha" && attempt === 1) {
            // A new upload while the build runs is written to both versions at once.
            await ingest(ALICE, "d-epsilon", ["Epsilon travel needs a signed itinerary."]);
            duringBuild.epsilonActive = (await chunkCounts("rag_document_chunks"))["d-epsilon"];
            duringBuild.epsilonBuilding = (await chunkCounts(table))["d-epsilon"];
            // A re-ingest of the document the builder has just read.
            await ingest(ALICE, "d-alpha", ["Alpha policy now requires director approval for remote work."]);
          }

          if (docId === "d-delta") {
            // Deleted after the builder read and embedded it.
            duringBuild.deleted = await remove(BOB, "d-delta");
          }
        },
      },
      space: modules.lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
    });

    assert.equal(result.versionId, 2);
    assert.equal(result.version.status, "ready");
    assert.equal(duringBuild.epsilonBuilding, duringBuild.epsilonActive, "the mid-build upload was dual-written");
    assert.ok(duringBuild.epsilonBuilding > 0);
    assert.ok(duringBuild.deleted, "the delete succeeded while the builder held the document");

    // Its own table at its own width, with every index, the policy, the grant
    // and the sparse-rank function, created by a non-superuser owner.
    const column = (
      await q(
        `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
          WHERE attrelid = 'rag_document_chunks_v2'::regclass AND attname = 'embedding'`
      )
    ).rows[0];

    assert.equal(column.type, `vector(${DIMENSIONS[MODEL_B]})`);

    const indexes = new Map(
      (
        await q(
          `SELECT c.relname, am.amname FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
            WHERE i.indrelid = 'rag_document_chunks_v2'::regclass`
        )
      ).rows.map((row) => [row.relname, row.amname])
    );

    assert.equal(indexes.get("rag_document_chunks_v2_embedding_idx"), "hnsw");
    assert.equal(indexes.get("rag_document_chunks_v2_search_vector_idx"), "gin");
    assert.ok(indexes.has("rag_document_chunks_v2_doc_id_idx"));

    const security = (
      await q(
        `SELECT c.relrowsecurity,
                EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
                has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS granted
           FROM pg_class c WHERE c.relname = 'rag_document_chunks_v2'`,
        [tenantRole]
      )
    ).rows[0];

    assert.deepEqual(security, { granted: true, policy: true, relrowsecurity: true });

    const fn = (
      await q(
        `SELECT p.prosecdef, p.proacl::text AS acl,
                has_function_privilege($1, p.oid, 'EXECUTE') AS tenant_can_execute
           FROM pg_proc p WHERE p.proname = 'rag_document_chunks_v2_sparse_rank'`,
        [tenantRole]
      )
    ).rows[0];

    assert.equal(fn.prosecdef, true);
    assert.equal(fn.tenant_can_execute, true);
    assert.doesNotMatch(fn.acl, /(^|[{,])=X/, "PUBLIC may not execute the owner-run function");

    // Same documents, same chunk counts; the re-ingest won over the builder's
    // stale bytes; the deleted document stayed deleted.
    const active = await chunkCounts("rag_document_chunks");
    const built = await chunkCounts("rag_document_chunks_v2");

    assert.deepEqual(built, active);
    assert.equal(built["d-delta"], undefined);
    assert.match(
      (await q(`SELECT content FROM rag_document_chunks_v2 WHERE doc_id = 'd-alpha'`)).rows[0].content,
      /director approval/
    );
    assert.deepEqual(
      (await q(`SELECT DISTINCT embedding_model, embedding_dimensions FROM rag_document_chunks_v2`)).rows,
      [{ embedding_dimensions: DIMENSIONS[MODEL_B], embedding_model: MODEL_B }]
    );
    assert.equal((await versionRow(2)).chunk_count, String(Object.values(built).reduce((a, b) => a + b, 0)));
  });

  test("the CLI activates the new version in another process while tenant /chat and searches run here without an error", async () => {
    const validation = await modules.lifecycle.validateIndexVersion({
      probe: { minRecall: 0.8, sampleSize: 4, topK: 10 },
      versionId: 2,
    });

    assert.equal(validation.ok, true, validation.reasons.join(" "));
    assert.equal(validation.probe.selfRetrieval.sampled, 4);

    const stop = { value: false };
    const errors = [];
    const answered = [];
    const queriesInBBefore = queriesIn(MODEL_B);
    const loops = Array.from({ length: 4 }, (_, index) =>
      (async () => {
        while (!stop.value) {
          try {
            if (index % 2 === 0) {
              const response = await modules.tenant.runWithDatabaseTenant(ALICE, () =>
                modules.rag.default(["d-alpha", "d-gamma", "d-epsilon"], "What does the alpha policy require?", {
                  accessScope: ALICE,
                })
              );

              answered.push(response.retrieval?.vectorStoreProvider);
            } else {
              const found = await search(BOB, "beta budget meals", ["d-beta"]);

              if (!topDocIds(found).includes("d-beta")) {
                errors.push(new Error("bob's search lost d-beta"));
              }
            }
          } catch (error) {
            errors.push(error);
          }
        }
      })()
    );

    try {
      await sleep(3 * POINTER_TTL_MS);

      // No LISTEN, no restart: this process learns of the switch only from the
      // pointer once its TTL has run out.
      const cli = await execFileAsync(process.execPath, [cliPath, "activate", "2", "--json"], {
        cwd: tempRoot,
        env: { ...process.env },
        timeout: 60_000,
      });
      const activation = JSON.parse(cli.stdout);

      assert.equal(activation.activeVersionId, 2);
      assert.equal(activation.previousVersionId, 1);
      await sleep(4 * POINTER_TTL_MS);
    } finally {
      stop.value = true;
      await Promise.all(loops);
    }

    assert.deepEqual(errors.map((error) => error.message), []);
    assert.ok(answered.length > 4, "the /chat loop kept answering");
    assert.ok(
      queriesIn(MODEL_B) > queriesInBBefore,
      "after the switch, queries are embedded in version 2's own model"
    );
    assert.equal((await modules.pgvector.getActivePgvectorVersion()).versionId, 2);

    const pointer = await pointerRow();
    const previous = await versionRow(1);

    assert.equal(pointer.active_version_id, 2);
    assert.equal(pointer.previous_version_id, 1);
    assert.equal(Number(pointer.generation), 2);
    assert.equal(previous.status, "ready");
    assert.ok(previous.dual_write_until > new Date(), "version 1 keeps receiving writes");
    assert.equal(previous.embedding_space_source, "pinned", "the switch pinned version 1 to the space it was verified under");
    assert.equal(previous.embedding_model, MODEL_A);
    assert.equal(previous.embedding_dimensions, DIMENSIONS[MODEL_A]);
    assert.equal((await versionRow(2)).status, "active");
    assert.deepEqual(topDocIds(await search(ALICE, "alpha approval", ["d-alpha", "d-gamma"])).slice(0, 1), ["d-alpha"]);
  });

  test("writes during the grace period reach version 1, so rolling back loses nothing", async () => {
    await ingest(ALICE, "d-zeta", ["Zeta retention keeps records for seven years."]);
    await remove(BOB, "d-beta");

    for (const table of ["rag_document_chunks", "rag_document_chunks_v2"]) {
      const counts = await chunkCounts(table);

      assert.ok(counts["d-zeta"] > 0, `${table} received the upload`);
      assert.equal(counts["d-beta"], undefined, `${table} received the delete`);
    }

    const rollback = await modules.lifecycle.rollbackIndexVersion();

    assert.equal(rollback.activeVersionId, 1);
    assert.equal(rollback.previousVersionId, 2);
    assert.equal(rollback.mode, "rollback");

    const queriesInBBefore = queriesIn(MODEL_B);
    const zeta = await search(ALICE, "zeta retention records", ["d-zeta", "d-alpha"]);

    assert.equal(topDocIds(zeta)[0], "d-zeta");
    assert.equal((await modules.pgvector.getActivePgvectorVersion()).versionId, 1);
    assert.equal(queriesIn(MODEL_B), queriesInBBefore, "version 1 answers with the configured model's query vector");
    assert.equal((await versionRow(2)).status, "ready");
  });

  test("retire refuses the active version and a version inside its rollback window, then drops the table and function", async () => {
    await assert.rejects(modules.lifecycle.retireIndexVersion({ versionId: 1 }), /is active/);
    await sleep(2 * POINTER_TTL_MS + 100);
    await assert.rejects(modules.lifecycle.retireIndexVersion({ versionId: 2 }), /--force/);

    const retired = await modules.lifecycle.retireIndexVersion({ force: true, versionId: 2 });

    assert.equal(retired.droppedTable, true);
    assert.equal((await q(`SELECT to_regclass('rag_document_chunks_v2') AS relation`)).rows[0].relation, null);
    assert.equal(
      (await q(`SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname = 'rag_document_chunks_v2_sparse_rank'`)).rows[0].n,
      0
    );
    assert.equal((await versionRow(2)).status, "retired");
    assert.equal((await pointerRow()).previous_version_id, null);

    // Later writes simply no longer include it.
    await ingest(ALICE, "d-gamma", ["Gamma renewal window is twelve months after the audit."]);
    await assert.rejects(modules.lifecycle.rollbackIndexVersion(), /no previous index version/);
  });

  test("a builder killed mid-build keeps others out while its lease lives; a scoped clear reaches the building table; resume finishes only what is missing", async () => {
    await ingest(BOB, "b-eta", ["Eta ledger lists every invoice."]);
    await ingest(BOB, "b-iota", ["Iota audit samples ten percent."]);
    await ingest(BOB, "b-theta", ["Theta escalation goes to the board."]);

    const leaseMs = 4000;
    const crashed = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: tempRoot,
      env: {
        ...process.env,
        INDEX_VERSIONS_IT_CHILD: "crash-build",
        INDEX_VERSIONS_IT_LEASE_MS: String(leaseMs),
      },
      timeout: 60_000,
    }).then(
      () => null,
      (error) => error
    );

    assert.equal(crashed?.code, 137, `the builder process died mid-build: ${crashed?.stderr ?? ""}`);

    const version = await versionRow(3);
    const progress = (
      await q(`SELECT doc_id, outcome FROM rag_index_versions_build_progress WHERE version_id = 3 ORDER BY doc_id`)
    ).rows;

    assert.equal(version.status, "building");
    assert.equal(version.builder_id, "crash-builder");
    assert.deepEqual(progress, [
      { doc_id: "b-eta", outcome: "indexed" },
      { doc_id: "b-iota", outcome: "indexed" },
    ]);

    // Two builders never run at once: the dead one's lease is still live.
    await assert.rejects(modules.lifecycle.resumeIndexVersionBuild(), /being built by crash-builder/);
    await assert.rejects(
      modules.lifecycle.startIndexVersionBuild({
        space: modules.lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
      }),
      /already building/
    );

    // A clear during the build is written to the building version too.
    assert.ok((await chunkCounts("rag_document_chunks_v3"))["b-eta"] > 0);
    await modules.tenant.runWithDatabaseTenant(BOB, () => modules.rag.clearDocuments({ accessScope: BOB }));
    assert.deepEqual(
      (await q(`SELECT DISTINCT owner_user_id FROM rag_document_chunks_v3`)).rows.map((row) => row.owner_user_id),
      []
    );

    await sleep(leaseMs + 200);

    const resumedDocs = [];
    const resumed = await modules.lifecycle.resumeIndexVersionBuild({
      builderId: "resume-builder",
      hooks: { afterDocument: ({ docId, outcome }) => resumedDocs.push(`${docId}:${outcome}`) },
    });

    assert.equal(resumed.versionId, 3);
    assert.equal(resumed.version.status, "ready");
    assert.deepEqual(resumedDocs, ["d-alpha:indexed", "d-epsilon:indexed", "d-gamma:indexed", "d-zeta:indexed"]);
    assert.deepEqual(await chunkCounts("rag_document_chunks_v3"), await chunkCounts("rag_document_chunks"));

    const activation = await modules.lifecycle.activateIndexVersion({
      probe: { sampleSize: 3, topK: 10 },
      versionId: 3,
    });

    assert.equal(activation.activeVersionId, 3);
    assert.equal(activation.validation.probe.selfRetrieval.recall, 1);
  });

  test("the new version's table isolates tenants like version 1, and health reports it", async () => {
    await ingest(BOB, "b-eta", ["Eta ledger lists every invoice."]);

    assert.deepEqual(
      (await asTenant(ALICE, `SELECT DISTINCT owner_user_id FROM rag_document_chunks_v3 ORDER BY 1`)).rows,
      [{ owner_user_id: "alice" }]
    );
    assert.deepEqual(
      (await asTenant(BOB, `SELECT DISTINCT doc_id FROM rag_document_chunks_v3 ORDER BY 1`)).rows,
      [{ doc_id: "b-eta" }]
    );
    await assert.rejects(
      asTenant(
        ALICE,
        `INSERT INTO rag_document_chunks_v3
           (chunk_id, doc_id, chunk_index, content, owner_user_id, workspace_id, embedding_model, embedding_dimensions, embedding)
         VALUES ('forged:0', 'b-eta', 99, 'forged', 'bob', 'ws-b', $1, 5, '[1,0,0,0,0]')`,
        [MODEL_C]
      ),
      /row-level security/
    );

    // Alice asks about both her own and Bob's documents: the row policy on the
    // new table (dense route) and its sparse-rank function (lexical route over
    // several documents) return only hers.
    const mixed = await search(ALICE, "eta ledger alpha policy", ["b-eta", "d-alpha", "d-zeta"], 8);

    assert.ok(mixed.results.length > 0);
    assert.ok(mixed.routes.sparse.candidateCount > 0);
    assert.ok(topDocIds(mixed).every((docId) => docId !== "b-eta"), `alice saw ${topDocIds(mixed)}`);
    assert.deepEqual(topDocIds(await search(BOB, "eta ledger", ["b-eta"])), ["b-eta"]);

    const report = await modules.health.buildHealthReport();
    const vectorStore = report.checks.vectorStore;

    assert.equal(vectorStore.status, "ok", vectorStore.message);
    assert.equal(vectorStore.table, "rag_document_chunks_v3");
    assert.equal(vectorStore.activeVersion.versionId, 3);
    assert.equal(vectorStore.embedding.model, MODEL_C);
    assert.equal(vectorStore.embedding.matches, true);
    assert.equal(vectorStore.indexVersions.active.versionId, 3);
    assert.equal(vectorStore.indexVersions.previousVersionId, 1);
    assert.ok(
      vectorStore.indexVersions.warnings.some((warning) => warning.code === "configuration_differs_from_active"),
      "the configured model differs from the active version's"
    );
    assert.equal(report.checks.rowLevelSecurity.status, "ok", report.checks.rowLevelSecurity.message);
    // Eleven tenant tables (ten plus the staged ingest's outputs, migration
    // 017) and the live version's own chunk table.
    assert.equal(report.checks.rowLevelSecurity.protectedTableCount, 12);
    assert.equal(report.checks.rowLevelSecurity.sparseRankExecutable, true);
  });

  test("retire drops a version table a short lock attempt at a time, so a long reader of documents never stalls the others", async (t) => {
    const build = await modules.lifecycle.startIndexVersionBuild({
      builderId: "retire-builder",
      space: modules.lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
    });
    const table = `rag_document_chunks_v${build.versionId}`;

    assert.equal(build.version.status, "ready");

    // A long reader of documents (pg_dump, a validate's join, a health count):
    // dropping the version table needs an AccessExclusiveLock on documents,
    // because its foreign key's triggers live there.
    const reader = new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL });

    await reader.connect();

    const latencies = [];
    let pending;

    try {
      await reader.query("BEGIN");
      await reader.query("SELECT COUNT(*) FROM rag_documents");

      const retiring = modules.lifecycle.retireIndexVersion({
        dropAttempts: 4,
        dropLockTimeoutMs: 100,
        dropRetryDelayMs: 150,
        versionId: build.versionId,
      });
      const deadline = Date.now() + 900;

      // Fresh readers of documents keep answering while retire tries.
      while (Date.now() < deadline) {
        const startedAt = Date.now();

        await q("SELECT COUNT(*) FROM rag_documents");
        latencies.push(Date.now() - startedAt);
        await sleep(15);
      }

      pending = await retiring;
    } finally {
      await reader.query("ROLLBACK").catch(() => {});
      await reader.end();
    }

    t.diagnostic(
      `documents readers during retire: n=${latencies.length}, max ${Math.max(...latencies)} ms, drop attempts ${pending.dropAttempts}`
    );
    assert.ok(latencies.length > 10, `readers ran during the retire (${latencies.length})`);
    assert.ok(
      Math.max(...latencies) < 600,
      `a reader of documents waited at most about one lock attempt (${Math.max(...latencies)} ms; the old retire held the queue for up to 10 s)`
    );
    assert.equal(pending.dropPending, true, "the drop never got its lock past the long reader");
    assert.equal((await versionRow(build.versionId)).status, "retired", "retired at once: no write goes to it");
    assert.ok((await q(`SELECT to_regclass($1) AS relation`, [table])).rows[0].relation);

    await ingest(ALICE, "d-after-retire", ["Kappa travel needs a receipt."]);
    assert.equal((await chunkCounts(table))["d-after-retire"], undefined, "a retired version takes no write");

    // With the reader gone, retire again finishes the drop.
    const finished = await modules.lifecycle.retireIndexVersion({ versionId: build.versionId });

    assert.equal(finished.droppedTable, true);
    assert.equal(finished.previousStatus, "retired");
    assert.equal((await q(`SELECT to_regclass($1) AS relation`, [table])).rows[0].relation, null);
    await assert.rejects(modules.lifecycle.retireIndexVersion({ versionId: build.versionId }), /already retired/);
  });

  test("an upload whose chunks a non-serving version's model cannot embed goes on, and that version is fenced", async () => {
    const build = await modules.lifecycle.startIndexVersionBuild({
      builderId: "fence-builder",
      space: modules.lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
    });
    const table = `rag_document_chunks_v${build.versionId}`;

    // The model of the built, not yet activated version goes away.
    modules.openai.configureOpenAIProvider({
      ...embedding.provider,
      embedTexts: async (texts, options) => {
        if (options?.embeddingSpace?.model === MODEL_B) {
          throw Object.assign(new Error("model not found"), { status: 404 });
        }

        return embedding.provider.embedTexts(texts, options);
      },
    });

    try {
      await modules.versions.readIndexVersionSnapshot({ force: true });
      await ingest(ALICE, "d-fenced", ["Lambda expenses need two approvals."]);
    } finally {
      modules.openai.configureOpenAIProvider(embedding.provider);
    }

    const version = await versionRow(build.versionId);

    assert.equal(version.status, "failed");
    assert.match(version.last_error, /could not embed its chunks in versions-it-embed-b\/6: model not found/);
    assert.ok((await chunkCounts("rag_document_chunks_v3"))["d-fenced"] > 0, "the active version got the upload");
    assert.equal((await chunkCounts(table))["d-fenced"], undefined);
    await assert.rejects(
      modules.lifecycle.activateIndexVersion({ versionId: build.versionId }),
      /only a ready version can be activated/
    );
    await modules.lifecycle.retireIndexVersion({ versionId: build.versionId });
  });
}
