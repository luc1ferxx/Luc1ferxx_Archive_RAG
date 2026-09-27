import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

// Real-database suite for the pgvector sparse route's statistics, Okapi BM25
// and common-term pruning (migrations 029 and 030,
// rag/vector-store-pgvector-sparse.js): the statistics (folded totals plus the
// append-only log) stay exact through every write, writers of one scope never
// wait on each other for them nor deadlock across version tables, the scores
// equal the local BM25 store's over the same chunks, pruning takes the paths
// it names, exhaustive ts_rank_cd through the search function equals the plain
// statement, one tenant's statistics and chunks never reach another's search,
// the sparse_length backfill changes no statistic, and a new index version's
// table gets (and a retired one loses) the same objects.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create databases and roles (CI's service and
// scripts/run-pgvector-integration.sh qualify); otherwise it is reported as
// skipped, never as passed. It provisions its own database and tenant role, so
// the other integration suites that clear shared tables cannot interfere, and
// drops both afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("pgvector BM25 integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `bm25_it_${suffix}`;
  const tenantRole = `bm25_it_tenant_${suffix}`;
  const withDatabase = (url, name) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;
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

  const ALICE = { userId: "alice", workspaceId: "ws-a" };
  const BOB = { userId: "bob", workspaceId: "ws-b" };
  const TABLE = "rag_document_chunks";

  let modules;
  let tempRoot;
  let sourceFilePath;

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "bm25-integration-"));
    sourceFilePath = path.join(tempRoot, "source.pdf");
    await writeFile(sourceFilePath, "%PDF-1.4 bm25 fixture");
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    Object.assign(process.env, {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "bm25-integration-key",
      OPENAI_EMBEDDING_MODEL: "bm25-it-embedding",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
      RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
      RAG_EMBEDDING_DIMENSIONS: "4",
      RAG_LONG_MEMORY_ENABLED: "false",
      SESSION_MEMORY_STORE_PROVIDER: "memory",
      VECTOR_STORE_PROVIDER: "pgvector",
    });
    delete process.env.LONG_MEMORY_DATABASE_URL;
    delete process.env.RAG_SPARSE_SCORING;
    delete process.env.RAG_BM25_K1;
    delete process.env.RAG_BM25_B;
    delete process.env.RAG_SPARSE_PRUNE_DF_FRACTION;
    delete process.env.RAG_SPARSE_COMMON_TERM_CAP;

    const [config, postgres, tenant, migrations, registry, rag, openai, pgvector, sparse, localSparse] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/doc-registry.js"),
        import("../rag/index.js"),
        import("../rag/openai.js"),
        import("../rag/vector-store-pgvector.js"),
        import("../rag/vector-store-pgvector-sparse.js"),
        import("../rag/sparse-store.js"),
      ]);

    modules = { config, localSparse, migrations, openai, pgvector, postgres, rag, registry, sparse, tenant };
    config.configureEmbeddingDimensions(4);
    openai.configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async () => [1, 0, 0, 0],
      embedTexts: async (texts) => texts.map(() => [1, 0, 0, 0]),
    });
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await migrations.runPostgresMigrations();
    await registry.initializeDocumentRegistry();
  });

  after(async () => {
    try {
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      await modules?.registry.resetDocumentRegistryStore();
      await modules?.postgres.resetPostgresPool();
    } finally {
      await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  const q = (sql, values) => modules.postgres.queryPostgres(sql, values);
  const asTenant = (scope, callback) => modules.tenant.runWithDatabaseTenant(scope, callback);
  const ingest = ({ docId, pages, scope = {} }) =>
    modules.rag.ingestDocumentPages({
      docId,
      fileName: `${docId}.pdf`,
      filePath: sourceFilePath,
      pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
      ownerUserId: scope.userId,
      workspaceId: scope.workspaceId,
    });
  const clearAll = () => modules.rag.clearDocuments({ deleteFiles: false });
  // pruneMinChunks 0: prune however few chunks the documents hold (the
  // default skips pruning below PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS).
  const bm25 = (args) =>
    modules.pgvector.searchPgvectorSparseDocuments({ pruneMinChunks: 0, scoring: "bm25", ...args });

  // The statistics a search sees (folded totals plus the unfolded log)
  // against a recomputation from the chunk table itself; then, after a fold at
  // rest, the log is empty and the totals alone are exact.
  const assertStatisticsExact = async (table = TABLE, { lengthsSet = true } = {}) => {
    const expectedScopes = (
      await q(`
        SELECT owner_user_id, workspace_id, count(*)::bigint AS chunk_count,
               sum((SELECT sum(cardinality(u.positions)) FROM unnest(search_vector) u))::bigint AS total_length
        FROM ${table} GROUP BY 1, 2 ORDER BY owner_user_id COLLATE "C", workspace_id COLLATE "C"`)
    ).rows.map((row) => ({
      chunkCount: Number(row.chunk_count),
      ownerUserId: row.owner_user_id,
      totalLength: Number(row.total_length),
      workspaceId: row.workspace_id,
    }));
    const expectedTerms = (
      await q(`
        SELECT c.owner_user_id, c.workspace_id, l AS lexeme, count(*)::bigint AS doc_freq
        FROM ${table} c, unnest(tsvector_to_array(c.search_vector)) l
        GROUP BY 1, 2, 3 ORDER BY c.owner_user_id COLLATE "C", c.workspace_id COLLATE "C", l COLLATE "C"`)
    ).rows.map((row) => ({
      docFreq: Number(row.doc_freq),
      lexeme: row.lexeme,
      ownerUserId: row.owner_user_id,
      workspaceId: row.workspace_id,
    }));
    const effective = await modules.sparse.readPgvectorSparseStatistics({ chunkTable: table, query: q });

    assert.deepEqual(effective.scopes, expectedScopes, `${table}: scope statistics`);
    assert.deepEqual(effective.terms, expectedTerms, `${table}: document frequencies`);

    if (lengthsSet) {
      const lengths = await q(`
        SELECT count(*)::int AS mismatched FROM ${table}
        WHERE sparse_length IS DISTINCT FROM (SELECT sum(cardinality(u.positions))::int FROM unnest(search_vector) u)`);

      assert.equal(lengths.rows[0].mismatched, 0, "every chunk's sparse_length is its tsvector's position count");
    }

    const { scopeLog, scopes, termLog, terms } = modules.sparse.getPgvectorSparseStatisticsTables(table);

    assert.equal(
      (await q(`SELECT ${modules.sparse.getPgvectorSparseFoldFunctionName(table)}() AS folded`)).rows[0].folded,
      true,
      "nothing else holds the fold at rest"
    );

    const counts = await q(
      `SELECT (SELECT count(*)::int FROM ${scopeLog}) AS scope_log, (SELECT count(*)::int FROM ${termLog}) AS term_log,
              (SELECT count(*)::int FROM ${scopes}) AS scopes, (SELECT count(*)::int FROM ${terms}) AS terms`
    );

    assert.deepEqual(
      counts.rows[0],
      { scope_log: 0, scopes: expectedScopes.length, term_log: 0, terms: expectedTerms.length },
      `${table}: a fold at rest leaves the log empty and only non-zero totals`
    );
    assert.deepEqual(
      await modules.sparse.readPgvectorSparseStatistics({ chunkTable: table, query: q }),
      effective,
      `${table}: folding changes no statistic`
    );
  };

  test("migrations 029/030 install the statistics, triggers, fold and search function; tenants only execute the search", async () => {
    const functions = await q(
      `SELECT proname, prosecdef FROM pg_proc WHERE proname LIKE '${TABLE}\\_%' ORDER BY 1`
    );
    const names = functions.rows.map((row) => row.proname);
    const ownerRun = [
      `${TABLE}_sparse_fold`,
      `${TABLE}_sparse_search`,
      `${TABLE}_sparse_stats_del`,
      `${TABLE}_sparse_stats_ins`,
      `${TABLE}_sparse_stats_trunc`,
      `${TABLE}_sparse_stats_upd`,
    ];

    for (const name of [`${TABLE}_install_bm25`, `${TABLE}_sparse_length`, ...ownerRun]) {
      assert.ok(names.includes(name), `${name} exists`);
    }

    for (const name of ownerRun) {
      assert.equal(functions.rows.find((row) => row.proname === name).prosecdef, true, `${name} runs as the owner`);
    }

    const statisticsTables = Object.values(modules.sparse.getPgvectorSparseStatisticsTables(TABLE)).sort();
    const policies = await q(
      `SELECT c.relname FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
       WHERE c.relrowsecurity AND c.relname = ANY($1::text[]) ORDER BY 1`,
      [statisticsTables]
    );

    assert.deepEqual(policies.rows.map((row) => row.relname), statisticsTables);

    // No log table has a unique index: concurrent writers only ever append.
    const unique = await q(
      `SELECT count(*)::int AS n FROM pg_index WHERE indisunique AND indrelid = ANY(ARRAY[$1::regclass, $2::regclass])`,
      [`${TABLE}_sparse_scope_log`, `${TABLE}_sparse_term_log`]
    );

    assert.equal(unique.rows[0].n, 0);

    const grants = await q(
      `SELECT bool_or(has_table_privilege($1, t, 'SELECT') OR has_table_privilege($1, t, 'INSERT')) AS tables,
              has_function_privilege($1, '${TABLE}_sparse_search${modules.sparse.PGVECTOR_SPARSE_SEARCH_SIGNATURE}', 'EXECUTE') AS search,
              has_function_privilege($1, '${TABLE}_sparse_fold()', 'EXECUTE') AS fold,
              has_function_privilege($1, '${TABLE}_install_bm25(text, regconfig)', 'EXECUTE') AS install
       FROM unnest($2::text[]) AS t`,
      [tenantRole, statisticsTables]
    );

    assert.deepEqual(grants.rows[0], { fold: false, install: false, search: true, tables: false });

    const status = await modules.pgvector.describePgvectorStatus();

    assert.equal(status.sparseScoring.searchFunctionInstalled, true);

    // The health probe covers every statistics table and the search function.
    const targets = await modules.pgvector.describePgvectorSparseRowLevelSecurityTargets();

    assert.deepEqual([...targets.statisticsTables].sort(), statisticsTables);
    assert.equal(targets.searchFunction, `${TABLE}_sparse_search${modules.sparse.PGVECTOR_SPARSE_SEARCH_SIGNATURE}`);
    assert.equal(targets.searchFunctionUsed, true, "pruning is on by default");

    // checks.rowLevelSecurity fails when the tenant loses the grant (a
    // changed POSTGRES_TENANT_ROLE, a restore), and passes once it is back.
    const { buildHealthReport } = await import("../health.js");
    const signature = `${TABLE}_sparse_search${modules.sparse.PGVECTOR_SPARSE_SEARCH_SIGNATURE}`;

    assert.equal((await buildHealthReport()).checks.rowLevelSecurity.sparseSearchExecutable, true);
    await q(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${tenantRole}`);

    try {
      const denied = (await buildHealthReport()).checks.rowLevelSecurity;

      assert.equal(denied.status, "error");
      assert.equal(denied.sparseSearchExecutable, false);
      assert.match(denied.message, /migration 030/);

      // Pruning off and ts_rank_cd: tenants never call it, so health does not require it.
      process.env.RAG_SPARSE_PRUNE_DF_FRACTION = "off";
      assert.equal((await buildHealthReport()).checks.rowLevelSecurity.status, "ok");
    } finally {
      delete process.env.RAG_SPARSE_PRUNE_DF_FRACTION;
      await q(`GRANT EXECUTE ON FUNCTION ${signature} TO ${tenantRole}`);
    }
  });

  test("statistics stay exact through ingest, replacement, delete, cascade, clear and truncate", async () => {
    await clearAll();
    await ingest({ docId: "st-a", pages: ["Alpha beta gamma. Alpha again.", "Beta delta epsilon policy."], scope: ALICE });
    await ingest({ docId: "st-b", pages: ["Gamma zeta eta theta alpha."], scope: BOB });
    await ingest({ docId: "st-c", pages: ["Unscoped gamma notes, gamma twice."] });
    assert.ok((await q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_terms`)).rows[0].n > 10);
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_scopes`)).rows[0].n, 3);
    await assertStatisticsExact();

    // Replacement: fewer, different chunks.
    await ingest({ docId: "st-a", pages: ["Omega only now."], scope: ALICE });
    await assertStatisticsExact();

    // Written and deleted as the tenant role, which holds no grant on the
    // statistics tables: the owner-run triggers keep them exact all the same.
    await asTenant(ALICE, () => ingest({ docId: "st-t", pages: ["Tenant written alpha omega.", "Second page."], scope: ALICE }));
    await assertStatisticsExact();
    await asTenant(ALICE, () => modules.rag.deleteDocument("st-t", { accessScope: ALICE, deleteFile: false }));
    await assertStatisticsExact();

    // Delete through the store, then a document row's cascading delete.
    await modules.rag.deleteDocument("st-b", { accessScope: BOB, deleteFile: false });
    await assertStatisticsExact();
    await q(`DELETE FROM ${modules.config.getDocumentsPostgresTable()} WHERE doc_id = 'st-c'`);
    await assertStatisticsExact();

    // A scope emptied by a delete keeps no lexeme rows once folded.
    const bobTerms = await q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_terms WHERE owner_user_id = 'bob'`);

    assert.equal(bobTerms.rows[0].n, 0);

    await clearAll();
    await assertStatisticsExact();
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_terms`)).rows[0].n, 0);

    await ingest({ docId: "st-d", pages: ["Truncate me, alpha."], scope: ALICE });
    await q(`TRUNCATE ${TABLE}`);
    await assertStatisticsExact();
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_scopes`)).rows[0].n, 0);
    await clearAll();
  });

  test("concurrent writers of one scope neither deadlock nor lose a count", async () => {
    await clearAll();

    const words = ["amber", "basalt", "cobalt", "dune", "ember", "fjord", "garnet", "harbor"];
    // Every document holds every word, in a different order, so the writers
    // contend for the same lexeme rows.
    const pagesFor = (index) =>
      Array.from({ length: 4 }, (_, page) =>
        [...words.slice((index + page) % words.length), ...words.slice(0, (index + page) % words.length)].join(" ")
      );

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => ingest({ docId: `cc-${index}`, pages: pagesFor(index), scope: ALICE }))
    );
    await assertStatisticsExact();

    // Replacements and deletes racing each other.
    await Promise.all([
      ...Array.from({ length: 4 }, (_, index) => ingest({ docId: `cc-${index}`, pages: pagesFor(index + 3).slice(0, 2), scope: ALICE })),
      ...Array.from({ length: 4 }, (_, index) => modules.rag.deleteDocument(`cc-${index + 4}`, { accessScope: ALICE, deleteFile: false })),
    ]);
    await assertStatisticsExact();
    await clearAll();
  });

  test("two transactions writing the same lexemes in opposite order do not deadlock", async () => {
    await clearAll();

    const documents = modules.config.getDocumentsPostgresTable();

    await q(
      `INSERT INTO ${documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
       VALUES ('dl-a', 'a.pdf', '\\x'::bytea, 'alice', 'ws-a'), ('dl-b', 'b.pdf', '\\x'::bytea, 'alice', 'ws-a')`
    );

    const connect = async () => {
      const client = new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL });

      await client.connect();
      return client;
    };
    const insertChunk = (client, docId, index, text) =>
      client.query(
        `INSERT INTO ${TABLE} (chunk_id, doc_id, chunk_index, content, search_text, owner_user_id, workspace_id,
           embedding_model, embedding_dimensions, embedding)
         VALUES ($1, $2, $3, $4, $4, 'alice', 'ws-a', 'bm25-it-embedding', 4, '[1,0,0,0]')`,
        [`${docId}:${index}`, docId, index, text]
      );
    const [first, second] = await Promise.all([connect(), connect()]);

    try {
      // Each transaction's first statement takes one lexeme, its second the
      // other: without the scope row taken first, first waits for "basalt"
      // while second waits for "amber" -- a deadlock PostgreSQL would break by
      // aborting one of them.
      await first.query("BEGIN");
      await second.query("BEGIN");
      await insertChunk(first, "dl-a", 0, "amber");

      const secondDone = (async () => {
        await insertChunk(second, "dl-b", 0, "basalt");
        await insertChunk(second, "dl-b", 1, "amber");
        await second.query("COMMIT");
      })();

      // Let the second transaction reach its lock wait before the first
      // takes its second lexeme.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await insertChunk(first, "dl-a", 1, "basalt");
      await first.query("COMMIT");
      await secondDone;
    } finally {
      await Promise.all([first.end(), second.end()]);
    }

    const amber = await modules.sparse.readPgvectorSparseStatistics({ chunkTable: TABLE, lexemes: ["amber"], query: q });

    assert.equal(amber.terms[0].docFreq, 2);
    await assertStatisticsExact();
    await q(`DELETE FROM ${documents} WHERE doc_id IN ('dl-a', 'dl-b')`);
    await assertStatisticsExact();
  });

  const connectClient = async () => {
    const client = new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL });

    await client.connect();
    return client;
  };
  const insertRawChunk = (client, table, docId, index, text) =>
    client.query(
      `INSERT INTO ${table} (chunk_id, doc_id, chunk_index, content, search_text, owner_user_id, workspace_id,
         embedding_model, embedding_dimensions, embedding)
       VALUES ($1, $2, $3, $4, $4, 'alice', 'ws-a', 'bm25-it-embedding', 4, '[1,0,0,0]')`,
      [`${docId}:${index}`, docId, index, text]
    );
  // Resolves with the session's wait event while `promise` is still pending
  // (null once it settled): whether a statement is blocked on a lock.
  const waitEventWhilePending = async (pid, promise, timeoutMs = 1500) => {
    let settled = false;

    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    for (const startedAt = Date.now(); Date.now() - startedAt < timeoutMs; ) {
      if (settled) {
        return null;
      }

      const activity = await q(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);

      if (activity.rows[0]?.wait_event_type === "Lock") {
        return "Lock";
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return settled ? null : "timeout";
  };

  test("a writer never waits on another open writer of the same scope for the statistics", async () => {
    await clearAll();

    const documents = modules.config.getDocumentsPostgresTable();

    await q(
      `INSERT INTO ${documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
       VALUES ('hw-a', 'a.pdf', '\\x'::bytea, 'alice', 'ws-a'), ('hw-b', 'b.pdf', '\\x'::bytea, 'alice', 'ws-a')`
    );

    const [first, second] = await Promise.all([connectClient(), connectClient()]);

    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      // The first writer keeps its transaction open after a write that shares
      // every lexeme with the second's; the second must not queue behind it.
      await insertRawChunk(first, TABLE, "hw-a", 0, "amber basalt cobalt");
      await second.query("SET LOCAL lock_timeout = '2s'");
      await insertRawChunk(second, TABLE, "hw-b", 0, "amber basalt cobalt dune");
      await insertRawChunk(second, TABLE, "hw-b", 1, "cobalt ember");
      await second.query("COMMIT");
      await insertRawChunk(first, TABLE, "hw-a", 1, "fjord amber");
      await first.query("COMMIT");
    } finally {
      await Promise.all([first.end(), second.end()]);
    }

    await assertStatisticsExact();
    await q(`DELETE FROM ${documents} WHERE doc_id IN ('hw-a', 'hw-b')`);
    await assertStatisticsExact();
  });

  test("a clear cascading through two live version tables and an ingest writing them in the other order do not deadlock", async () => {
    await clearAll();

    const documents = modules.config.getDocumentsPostgresTable();
    const versionTable = `${TABLE}_v98`;

    // A version table created after the base table: its foreign-key trigger on
    // the documents table fires after the base table's in a cascading delete,
    // while an ingest writes the active (newer) version first.
    await modules.postgres.withPostgresTransaction(async (client) =>
      client.query(
        [
          await modules.migrations.renderIndexVersionChunkTableDdl({ chunkTable: versionTable, dimensions: 4 }),
          modules.sparse.renderPgvectorBm25InstallStatement({ chunkTable: versionTable, textSearchConfig: "simple" }),
        ].join("\n")
      )
    );

    try {
      await q(
        `INSERT INTO ${documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
         VALUES ('dd-old', 'old.pdf', '\\x'::bytea, 'alice', 'ws-a')`
      );

      for (const table of [TABLE, versionTable]) {
        await insertRawChunk({ query: (sql, values) => q(sql, values) }, table, "dd-old", 0, "amber basalt");
      }

      const [ingest, clear] = await Promise.all([connectClient(), connectClient()]);

      try {
        const clearPid = (await clear.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        await ingest.query("BEGIN");
        await clear.query("BEGIN");
        // The ingest of a new document of the same scope: the active version first.
        await ingest.query(
          `INSERT INTO ${documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
           VALUES ('dd-new', 'new.pdf', '\\x'::bytea, 'alice', 'ws-a')`
        );
        await insertRawChunk(ingest, versionTable, "dd-new", 0, "amber cobalt");

        // The clear: the registry rows, then the chunks by cascade (base first).
        const clearing = clear.query(
          `DELETE FROM ${documents} WHERE owner_user_id = 'alice' AND workspace_id = 'ws-a'`
        );

        assert.equal(await waitEventWhilePending(clearPid, clearing), null, "the clear does not wait on the ingest");
        await insertRawChunk(ingest, TABLE, "dd-new", 0, "amber cobalt");
        await ingest.query("COMMIT");
        assert.equal((await clearing).rowCount, 1);
        await clear.query("COMMIT");
      } finally {
        await Promise.all([ingest.end(), clear.end()]);
      }

      await assertStatisticsExact();
      await assertStatisticsExact(versionTable);
      await q(`DELETE FROM ${documents} WHERE doc_id = 'dd-new'`);
      await assertStatisticsExact();
      await assertStatisticsExact(versionTable);
    } finally {
      await q(
        [
          modules.migrations.renderIndexVersionDropDdl({
            chunkTable: versionTable,
            sparseRankFunction: `${versionTable}_sparse_rank`,
          }),
          modules.sparse.renderPgvectorBm25DropDdl({ chunkTable: versionTable }),
        ].join("\n")
      );
    }
  });

  test("BM25 scores equal the local BM25 store's over the same chunks", async () => {
    await clearAll();
    await modules.localSparse.clearSparseIndex();

    const corpus = {
      "eq-1": ["The amber ceiling limits travel spending to 2400 dollars per quarter.", "Travel approval needs a manager."],
      "eq-2": ["Parental leave lasts sixteen weeks; annual leave is twenty days.", "Leave requests go to human resources."],
      "eq-3": ["Cobalt ceiling applies to equipment. Equipment purchases above the cobalt ceiling need approval approval."],
      "eq-4": ["Quarterly travel reports summarize travel, travel budget and travel approval."],
    };

    for (const [docId, pages] of Object.entries(corpus)) {
      await ingest({ docId, pages });
    }

    // The same chunks, as the pgvector table stores them, into the local store.
    const rows = await q(`SELECT chunk_id, content, metadata FROM ${TABLE} ORDER BY chunk_id`);

    await modules.localSparse.addDocumentsToSparseIndex({
      documents: rows.rows.map((row) => ({ id: row.chunk_id, metadata: row.metadata, pageContent: row.content })),
    });

    const docIds = Object.keys(corpus);

    for (const queryText of [
      "amber ceiling travel",
      "travel approval",
      "leave weeks",
      "cobalt ceiling approval equipment",
      "quarterly report budget",
    ]) {
      const local = await modules.localSparse.searchSparseDocuments({ docIds, queryText, topK: 50 });
      const remote = await bm25({ docIds, pruneDfFraction: null, queryText, topK: 50 });
      const localScores = new Map(local.map((result) => [result.document.id, result.sparseScore]));

      assert.equal(remote.length, local.length, `${queryText}: same candidates`);

      for (const result of remote) {
        assert.ok(localScores.has(result.document.id), `${queryText}: ${result.document.id} is a local candidate`);
        assert.ok(
          Math.abs(result.sparseScore - localScores.get(result.document.id)) < 1e-9,
          `${queryText}: ${result.document.id} scores ${result.sparseScore} vs local ${localScores.get(result.document.id)}`
        );
      }
    }

    // k1 and b are read by both stores.
    process.env.RAG_BM25_K1 = "0.9";
    process.env.RAG_BM25_B = "0.4";

    try {
      const local = await modules.localSparse.searchSparseDocuments({ docIds, queryText: "travel approval", topK: 50 });
      const remote = await bm25({ docIds, pruneDfFraction: null, queryText: "travel approval", topK: 50 });
      const localScores = new Map(local.map((result) => [result.document.id, result.sparseScore]));

      for (const result of remote) {
        assert.ok(Math.abs(result.sparseScore - localScores.get(result.document.id)) < 1e-9);
      }
    } finally {
      delete process.env.RAG_BM25_K1;
      delete process.env.RAG_BM25_B;
    }

    await modules.localSparse.clearSparseIndex();
    await clearAll();
  });

  test("common-term pruning takes the paths it names: rare terms, filled from common ones, and capped all-common queries", async () => {
    await clearAll();

    // "common" is in six of eleven chunks, "words" in five of them; "rare" in
    // one very long chunk.
    const filler = Array.from({ length: 60 }, (_, index) => `filler${index}`).join(" ");

    await ingest({
      docId: "pr-1",
      pages: [
        "common common common common common common common common",
        "common other words",
        "common more words",
        "common different words",
        "common unrelated words",
        "common final words",
        `rare ${filler}`,
        "nothing shared here",
        "still nothing shared",
        "last page nothing",
      ],
    });
    // A second document: ts_rank_cd takes the search function for several
    // documents only.
    await ingest({ docId: "pr-2", pages: ["zzz unrelated"] });

    const docIds = ["pr-1", "pr-2"];
    const idsOf = (results) => results.map((result) => result.document.id);
    const pathsOf = (results) => [...new Set(results.map((result) => result.sparseCandidates))];

    for (const scoring of ["bm25", "ts_rank_cd"]) {
      const search = (args) =>
        modules.pgvector.searchPgvectorSparseDocuments({ docIds, pruneMinChunks: 0, scoring, ...args });
      const exhaustive = await search({ pruneDfFraction: null, queryText: "common rare", topK: 1 });
      const pruned = await search({ pruneDfFraction: 0.5, queryText: "common rare", topK: 1 });

      // Exhaustive: the short chunk full of the common word wins. Pruned: only
      // the rare word generates candidates, so the rare chunk is the answer,
      // scored with the full query.
      assert.equal(exhaustive[0].document.pageContent.startsWith("common common"), true, scoring);
      // Without pruning ts_rank_cd keeps the plain statement (no path named).
      assert.deepEqual(pathsOf(exhaustive), [scoring === "bm25" ? "exhaustive" : undefined], scoring);
      assert.equal(pruned[0].document.pageContent.startsWith("rare"), true, scoring);
      assert.deepEqual(pathsOf(pruned), ["pruned"], scoring);
      assert.ok(pruned[0].sparseScore > 0);

      // One rare candidate but three asked for: filled from the common term;
      // with the cap above its matches the list is the exhaustive one.
      const filled = await search({ pruneDfFraction: 0.5, queryText: "common rare", topK: 3 });

      assert.deepEqual(idsOf(filled), idsOf(await search({ pruneDfFraction: null, queryText: "common rare", topK: 3 })));
      assert.deepEqual(pathsOf(filled), ["pruned_filled"], scoring);

      // Every term common, one word: at most the cap's candidates are scored.
      const single = await search({ commonTermCap: 2, pruneDfFraction: 0.5, queryText: "common", topK: 5 });

      assert.equal(single.length, 2, `${scoring}: two candidates scored, two returned`);
      assert.deepEqual(pathsOf(single), ["common_bounded"], scoring);
      assert.equal((await search({ pruneDfFraction: null, queryText: "common", topK: 5 })).length, 5);
      // Uncapped, the same query is exhaustive.
      assert.deepEqual(
        idsOf(await search({ commonTermCap: null, pruneDfFraction: 0.5, queryText: "common", topK: 5 })),
        idsOf(await search({ pruneDfFraction: null, queryText: "common", topK: 5 }))
      );

      // Every term common, several words: the chunks holding all of them first.
      const both = await search({ commonTermCap: 3, pruneDfFraction: 0.3, queryText: "common words", topK: 2 });

      assert.deepEqual(pathsOf(both), ["common_bounded"], scoring);
      assert.ok(
        both.every((result) => /common/.test(result.document.pageContent) && /words/.test(result.document.pageContent)),
        `${scoring}: ${both.map((result) => result.document.pageContent)}`
      );
      // A cap the common terms' frequencies (6 + 5) cannot reach cuts nothing:
      // no every-term pass, every match scored, the exhaustive list.
      assert.deepEqual(
        idsOf(await search({ commonTermCap: 11, pruneDfFraction: 0.3, queryText: "common words", topK: 4 })),
        idsOf(await search({ pruneDfFraction: null, queryText: "common words", topK: 4 })),
        scoring
      );

      // The default minimum scores eleven chunks exhaustively.
      assert.deepEqual(
        pathsOf(
          await modules.pgvector.searchPgvectorSparseDocuments({
            docIds,
            pruneDfFraction: 0.5,
            queryText: "common rare",
            scoring: "bm25",
            topK: 1,
          })
        ),
        ["exhaustive"]
      );
    }

    await clearAll();
  });

  test("exhaustive ts_rank_cd through the search function equals the plain statement, owner and tenant", async () => {
    await clearAll();
    await ingest({ docId: "rc-1", pages: ["Amber ceiling travel policy.", "Travel approval by a manager."], scope: ALICE });
    await ingest({ docId: "rc-2", pages: ["Amber travel amber reports.", "Budget and travel."], scope: ALICE });
    await ingest({ docId: "rc-3", pages: ["Unrelated notes on travel."], scope: ALICE });

    const docIds = ["rc-1", "rc-2", "rc-3"];
    const rows = (results) => results.map((result) => [result.document.id, result.sparseScore]);

    for (const runAs of [(callback) => callback(), (callback) => asTenant(ALICE, callback)]) {
      for (const queryText of ["amber travel", "travel approval budget", "ceiling"]) {
        const plain = await runAs(() =>
          modules.pgvector.searchPgvectorSparseDocuments({ docIds, pruneDfFraction: null, queryText, scoring: "ts_rank_cd", topK: 10 })
        );
        // Pruning on but the documents below its minimum: the function scores exhaustively.
        const viaFunction = await runAs(() =>
          modules.pgvector.searchPgvectorSparseDocuments({
            docIds,
            pruneDfFraction: 0.1,
            pruneMinChunks: 1_000_000,
            queryText,
            scoring: "ts_rank_cd",
            topK: 10,
          })
        );

        assert.ok(plain.length > 0, queryText);
        assert.equal(plain[0].sparseCandidates, undefined, "the plain statement ran");
        assert.equal(viaFunction[0].sparseCandidates, "exhaustive", "the search function ran");
        assert.deepEqual(rows(viaFunction), rows(plain), queryText);
      }
    }

    await clearAll();
  });

  test("the sparse_length backfill fills rows written before migration 029 and changes no statistic", async () => {
    await clearAll();
    await ingest({ docId: "bf-1", pages: ["Alpha beta gamma alpha.", "Delta epsilon."], scope: ALICE });
    await ingest({ docId: "bf-2", pages: ["Zeta eta theta.", "Iota kappa alpha."] });
    // Rows as migration 029 left them: no length. The update trigger logs the
    // exact difference (none) for rows whose length is cleared.
    await q(`UPDATE ${TABLE} SET sparse_length = NULL`);
    await assertStatisticsExact(TABLE, { lengthsSet: false });

    const before = await modules.sparse.readPgvectorSparseStatistics({ chunkTable: TABLE, query: q });
    const scores = async () =>
      (await bm25({ docIds: ["bf-1", "bf-2"], pruneDfFraction: null, queryText: "alpha delta", topK: 10 })).map(
        (result) => [result.document.id, result.sparseScore]
      );
    const scoresWithNullLengths = await scores();
    const report = await modules.sparse.backfillPgvectorSparseLength({
      batchSize: 2,
      chunkTables: [TABLE],
      query: q,
      withTransaction: (callback) =>
        modules.postgres.withPostgresTransaction((client) => callback((sql, values) => client.query(sql, values))),
    });

    assert.equal(report[0].missingBefore, 4);
    assert.equal(report[0].missingAfter, 0);
    assert.equal(report[0].updated, 4);
    // Filling a NULL with the count it stood for logs nothing.
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_term_log`)).rows[0].n, 0);
    assert.deepEqual(await modules.sparse.readPgvectorSparseStatistics({ chunkTable: TABLE, query: q }), before);
    assert.deepEqual(await scores(), scoresWithNullLengths, "BM25 counted the positions of the NULL rows");
    await assertStatisticsExact();
    await clearAll();
  });

  test("a tenant scores against its own scopes only and cannot read another tenant through the rank function", async () => {
    await clearAll();
    await ingest({ docId: "tn-alice", pages: ["Alpha policy for alice.", "Alpha appendix."], scope: ALICE });
    await ingest({
      docId: "tn-bob",
      pages: ["Bob notes.", "More bob notes.", "Bob archive.", "Alpha bob."],
      scope: BOB,
    });

    const aliceResults = await asTenant(ALICE, () =>
      bm25({ docIds: ["tn-alice", "tn-bob"], pruneDfFraction: null, queryText: "alpha policy", topK: 10 })
    );

    assert.deepEqual(
      [...new Set(aliceResults.map((result) => result.document.metadata.docId))],
      ["tn-alice"]
    );

    // Alice's IDF comes from her scope alone: the same scores as a store that
    // only ever held her chunks.
    await modules.localSparse.clearSparseIndex();

    const aliceRows = await q(`SELECT chunk_id, content, metadata FROM ${TABLE} WHERE doc_id = 'tn-alice'`);

    await modules.localSparse.addDocumentsToSparseIndex({
      documents: aliceRows.rows.map((row) => ({ id: row.chunk_id, metadata: row.metadata, pageContent: row.content })),
    });

    const local = await modules.localSparse.searchSparseDocuments({
      docIds: ["tn-alice"],
      queryText: "alpha policy",
      topK: 10,
    });
    const localScores = new Map(local.map((result) => [result.document.id, result.sparseScore]));

    for (const result of aliceResults) {
      assert.ok(Math.abs(result.sparseScore - localScores.get(result.document.id)) < 1e-9);
    }

    await modules.localSparse.clearSparseIndex();

    // Calling the owner-run function directly with Bob's document id, as
    // Alice, returns nothing, for either scoring; the statistics tables are
    // not hers to read at all.
    const directSql = (scoring) =>
      `SELECT chunk_id FROM ${TABLE}_sparse_search(to_tsquery('simple', 'alpha | bob'), to_tsvector('simple', 'alpha bob'),
         ARRAY['tn-bob'], 10, '${scoring}', 1.2, 0.75, 0.5, 0, 1)`;

    for (const scoring of ["bm25", "ts_rank_cd"]) {
      assert.equal((await asTenant(ALICE, () => q(directSql(scoring)))).rows.length, 0, scoring);
    }

    await assert.rejects(
      asTenant(ALICE, () => q(`SELECT count(*)::int AS n FROM ${TABLE}_sparse_terms WHERE owner_user_id = 'bob'`)),
      (error) => error.code === "42501"
    );

    // As the owner the same call reaches Bob's chunks.
    const owner = await q(directSql("bm25"));

    assert.ok(owner.rows.length > 0);
    await clearAll();
  });

  test("an index version's table gets its own statistics and rank function, and retiring drops them", async () => {
    const versionTable = `${TABLE}_v97`;
    const ddl = [
      await modules.migrations.renderIndexVersionChunkTableDdl({ chunkTable: versionTable, dimensions: 4 }),
      modules.sparse.renderPgvectorBm25InstallStatement({ chunkTable: versionTable, textSearchConfig: "simple" }),
    ].join("\n");

    await modules.postgres.withPostgresTransaction((client) => client.query(ddl));

    const installed = await q(`SELECT to_regprocedure($1) IS NOT NULL AS installed`, [
      `${modules.sparse.getPgvectorSparseSearchFunctionName(versionTable)}${modules.sparse.PGVECTOR_SPARSE_SEARCH_SIGNATURE}`,
    ]);

    assert.equal(installed.rows[0].installed, true);

    await q(
      `INSERT INTO ${modules.config.getDocumentsPostgresTable()} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
       VALUES ('v-doc', 'v.pdf', '\\x'::bytea, 'alice', 'ws-a')`
    );
    await q(
      `INSERT INTO ${versionTable} (chunk_id, doc_id, chunk_index, content, search_text, owner_user_id, workspace_id,
         embedding_model, embedding_dimensions, embedding)
       VALUES ('v-doc:0', 'v-doc', 0, 'x', 'version alpha alpha', 'alice', 'ws-a', 'm', 4, '[1,0,0,0]')`
    );
    await assertStatisticsExact(versionTable);

    await q(
      [
        modules.migrations.renderIndexVersionDropDdl({
          chunkTable: versionTable,
          sparseRankFunction: `${versionTable}_sparse_rank`,
        }),
        modules.sparse.renderPgvectorBm25DropDdl({ chunkTable: versionTable }),
      ].join("\n")
    );

    const left = await q(
      `SELECT (SELECT count(*)::int FROM pg_class WHERE relname LIKE '${versionTable}%') AS relations,
              (SELECT count(*)::int FROM pg_proc WHERE proname LIKE '${versionTable}%') AS functions`
    );

    assert.deepEqual(left.rows[0], { functions: 0, relations: 0 });
    await q(`DELETE FROM ${modules.config.getDocumentsPostgresTable()} WHERE doc_id = 'v-doc'`);
  });
}
