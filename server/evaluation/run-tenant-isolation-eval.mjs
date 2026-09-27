// run-tenant-isolation-eval.mjs
//
// Before/after measurement for PostgreSQL row-level security (migration 013).
// It provisions a throwaway database owned by a non-superuser login, applies
// the real migrations, seeds several tenants, and runs the same probes with
// POSTGRES_ROW_LEVEL_SECURITY=off (the owner connection, i.e. application
// filters only) and =enforce:
//
//   isolation  queries that forget their tenant filter, forged writes, and a
//              store asked for another tenant's scope, all issued while acting
//              for one tenant. Counts foreign rows seen and attacks that land.
//   overhead   p50/p95 latency of a store point read and of the dense and
//              sparse retrieval queries, per mode, interleaved so both modes
//              see the same cache state.
//   plans      which scan each retrieval query uses under each mode.
//
// Write probes run inside a transaction that is always rolled back, so the
// off-mode attacks do not change the data the other probes read.
//
// Usage:
//   node evaluation/run-tenant-isolation-eval.mjs [--database-url <admin url>]
//     [--tenants 20] [--docs-per-tenant 5] [--chunks-per-doc 100]
//     [--dimensions 64] [--iterations 300]
//
// The admin URL defaults to PGVECTOR_TEST_DATABASE_URL and needs CREATEROLE and
// CREATEDB (scripts/run-pgvector-integration.sh provides one with KEEP_CLUSTER=1).
// Everything created is dropped at the end.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

const parseArgs = (argv) => {
  const options = {
    chunksPerDoc: 100,
    databaseUrl: String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim(),
    dimensions: 64,
    docsPerTenant: 5,
    iterations: 300,
    tenants: 20,
  };
  const numeric = {
    "--chunks-per-doc": "chunksPerDoc",
    "--dimensions": "dimensions",
    "--docs-per-tenant": "docsPerTenant",
    "--iterations": "iterations",
    "--tenants": "tenants",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === "--database-url") {
      options.databaseUrl = argv[++index];
    } else if (numeric[flag]) {
      options[numeric[flag]] = Math.max(1, Math.floor(Number(argv[++index])));
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!options.databaseUrl) {
    throw new Error("Pass --database-url or set PGVECTOR_TEST_DATABASE_URL.");
  }

  if (options.tenants < 2) {
    throw new Error("--tenants must be at least 2.");
  }

  return options;
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

const adminQuery = async (url, sql) => {
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
};

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

const round = (value, digits = 2) => Number(value.toFixed(digits));

// Seeded so every run builds the same corpus.
const createRandom = (seed) => {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const VOCABULARY = [
  "alpha", "beta", "gamma", "delta", "policy", "contract", "renewal", "liability",
  "invoice", "payment", "retention", "privacy", "audit", "security", "vendor", "term",
];

const tenantScope = (index) => ({
  userId: `t${String(index).padStart(2, "0")}`,
  workspaceId: `ws${String(index).padStart(2, "0")}`,
});

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `rls_eval_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `rls_eval_tenant_${suffix}`;
  const databaseName = `rls_eval_${suffix}`;
  let modules = null;

  await adminQuery(
    options.databaseUrl,
    `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`
  );

  try {
    await adminQuery(options.databaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(
      withDatabase(options.databaseUrl, databaseName),
      "CREATE EXTENSION IF NOT EXISTS vector"
    );

    process.env.POSTGRES_DATABASE_URL = withDatabase(options.databaseUrl, databaseName, {
      password: ownerPassword,
      user: ownerRole,
    });
    process.env.POSTGRES_TENANT_ROLE = tenantRole;
    process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
    process.env.VECTOR_STORE_PROVIDER = "pgvector";
    process.env.OPENAI_EMBEDDING_MODEL = "tenant-isolation-eval";
    process.env.RAG_EMBEDDING_DIMENSIONS = String(options.dimensions);

    const [config, postgres, tenant, migrations, pgvector, taskStore] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/postgres-tenant.js"),
      import("../rag/db-migrations.js"),
      import("../rag/vector-store-pgvector.js"),
      import("../rag/postgres-task-store.js"),
    ]);

    modules = { postgres };
    config.configureEmbeddingDimensions(options.dimensions);
    migrations.resetPostgresMigrations();
    await migrations.runPostgresMigrations();

    const tables = {
      artifacts: { name: config.getWorkspaceArtifactsPostgresTable(), owner: "owner_user_id" },
      chunks: { name: config.getDocumentChunksPostgresTable(), owner: "owner_user_id" },
      documents: { name: config.getDocumentsPostgresTable(), owner: "owner_user_id" },
      longMemory: { name: config.getLongMemoryPostgresTable(), owner: "user_id" },
      runEvents: { name: config.getAgentRunEventsPostgresTable(), owner: "user_id" },
      runs: { name: config.getAgentRunsPostgresTable(), owner: "user_id" },
      snapshots: { name: `${config.getAgentRunsPostgresTable()}_approval_snapshots`, owner: "user_id" },
      taskEvents: { name: config.getTaskEventsPostgresTable(), owner: "user_id" },
      tasks: { name: config.getTasksPostgresTable(), owner: "user_id" },
    };
    const q = postgres.queryPostgres;
    const random = createRandom(20260925);
    const randomVector = () =>
      `[${Array.from({ length: options.dimensions }, () => (random() * 2 - 1).toFixed(4)).join(",")}]`;
    const randomText = () =>
      Array.from({ length: 12 }, () => VOCABULARY[Math.floor(random() * VOCABULARY.length)]).join(" ");

    // --- Seed as the owner ---------------------------------------------------
    const seedStartedAt = performance.now();

    for (let tenantIndex = 0; tenantIndex < options.tenants; tenantIndex += 1) {
      const scope = tenantScope(tenantIndex);
      const id = `${scope.userId}-1`;

      for (let docIndex = 0; docIndex < options.docsPerTenant; docIndex += 1) {
        const docId = `${scope.userId}-doc-${docIndex}`;

        await q(
          `INSERT INTO ${tables.documents.name} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [docId, `${docId}.pdf`, Buffer.from("%PDF-1.4"), scope.userId, scope.workspaceId]
        );

        const values = [];
        const rows = [];

        for (let chunkIndex = 0; chunkIndex < options.chunksPerDoc; chunkIndex += 1) {
          const base = values.length;
          const text = randomText();

          values.push(`${docId}:${chunkIndex}`, docId, chunkIndex, text, scope.userId, scope.workspaceId, randomVector());
          rows.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 4}, $${base + 5}, $${base + 6}, 'tenant-isolation-eval', ${options.dimensions}, $${base + 7}::vector)`
          );
        }

        await q(
          `INSERT INTO ${tables.chunks.name}
             (chunk_id, doc_id, chunk_index, content, search_text, owner_user_id, workspace_id,
              embedding_model, embedding_dimensions, embedding)
           VALUES ${rows.join(", ")}`,
          values
        );
      }

      await q(
        `INSERT INTO ${tables.tasks.name} (user_id, workspace_id, task_id, type, status)
         VALUES ($1, $2, $3, 'research', 'queued')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.taskEvents.name} (user_id, workspace_id, task_id, event_type)
         VALUES ($1, $2, $3, 'created')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.runs.name} (user_id, workspace_id, run_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.runEvents.name} (user_id, workspace_id, run_id, event_type)
         VALUES ($1, $2, $3, 'run_created')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.snapshots.name}
           (user_id, workspace_id, run_id, gate_id, capability_id, capability_version,
            approval_object_hash, snapshot_version, execution_input)
         VALUES ($1, $2, $3, 'gate-1', 'cap', '1', 'hash', 1, '{}'::jsonb)`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.artifacts.name}
           (owner_user_id, workspace_id, artifact_id, artifact_type, version, title, idempotency_key)
         VALUES ($1, $2, $3, 'report', '1', 'Report', $3)`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.longMemory.name} (memory_id, user_id, category, text)
         VALUES ($1, $2, 'preference', 'likes concise answers')`,
        [id, scope.userId]
      );
    }

    await q("ANALYZE");

    const seedMs = performance.now() - seedStartedAt;
    const actor = tenantScope(0);
    const victim = tenantScope(1);
    const actorDocIds = Array.from(
      { length: options.docsPerTenant },
      (_, docIndex) => `${actor.userId}-doc-${docIndex}`
    );
    const store = taskStore.createPostgresTaskStore({
      runMigrations: async () => ({ status: "ok" }),
    });
    const setMode = (mode) => {
      process.env.POSTGRES_ROW_LEVEL_SECURITY = mode;
    };
    const asActor = (callback) => tenant.runWithDatabaseTenant(actor, callback);

    class ProbeRollback extends Error {
      constructor(result) {
        super("probe rollback");
        this.result = result;
      }
    }

    // Runs one write as the actor and always rolls it back; reports whether
    // the database accepted it.
    const attemptWrite = async (sql, values = []) => {
      try {
        await asActor(() =>
          postgres.withPostgresTransaction(async (client) => {
            throw new ProbeRollback(await client.query(sql, values));
          })
        );
      } catch (error) {
        if (error instanceof ProbeRollback) {
          return { accepted: (error.result.rowCount ?? 0) > 0, rowCount: error.result.rowCount ?? 0 };
        }

        return { accepted: false, error: error.code ?? error.message };
      }

      throw new Error("A write probe did not roll back.");
    };

    const runIsolationProbes = async (mode) => {
      setMode(mode);

      const reads = {};

      for (const [key, table] of Object.entries(tables)) {
        const result = await asActor(() =>
          q(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE ${table.owner} <> $1)::int AS foreign_rows
             FROM ${table.name}`,
            [actor.userId]
          )
        );

        reads[key] = result.rows[0].foreign_rows;
      }

      const writes = {
        crossTenantDelete: await attemptWrite(
          `DELETE FROM ${tables.longMemory.name} WHERE user_id = $1`,
          [victim.userId]
        ),
        crossTenantUpdate: await attemptWrite(
          `UPDATE ${tables.tasks.name} SET status = 'canceled' WHERE user_id = $1`,
          [victim.userId]
        ),
        forgedInsert: await attemptWrite(
          `INSERT INTO ${tables.documents.name} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
           VALUES ('forged-doc', 'forged.pdf', '\\x00', $1, $2)`,
          [victim.userId, victim.workspaceId]
        ),
        upsertTakeover: await attemptWrite(
          `INSERT INTO ${tables.documents.name} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
           VALUES ($1, 'takeover.pdf', '\\x00', $2, $3)
           ON CONFLICT (doc_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
             workspace_id = EXCLUDED.workspace_id`,
          [`${victim.userId}-doc-0`, actor.userId, actor.workspaceId]
        ),
      };
      const wrongScopeRead = Boolean(
        await asActor(() => store.get({ accessScope: victim, taskId: `${victim.userId}-1` }))
      );
      const leakedTables = Object.values(reads).filter((count) => count > 0).length;
      const acceptedAttacks =
        Object.values(writes).filter((write) => write.accepted).length + (wrongScopeRead ? 1 : 0);

      return {
        acceptedAttacks,
        foreignRowsRead: Object.values(reads).reduce((sum, count) => sum + count, 0),
        leakedTables,
        probeCount: Object.keys(reads).length + Object.keys(writes).length + 1,
        reads,
        writes,
        wrongScopeRead,
      };
    };

    // --- Plans ---------------------------------------------------------------
    const queryVector = randomVector();
    const denseSql = `
      SELECT chunk_id FROM ${tables.chunks.name}
      WHERE doc_id = ANY($2::text[]) AND embedding_model = 'tenant-isolation-eval'
        AND embedding_dimensions = ${options.dimensions}
      ORDER BY embedding <=> $1::vector ASC, chunk_id ASC LIMIT 8`;
    const sparseSql = `
      SELECT chunk_id FROM ${tables.chunks.name}
      WHERE doc_id = ANY($2::text[]) AND search_vector @@ plainto_tsquery('simple', $1)
      ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', $1)) DESC LIMIT 8`;
    const summarizePlan = (plan) => {
      const nodes = [];
      const visit = (node) => {
        nodes.push(node["Index Name"] ? `${node["Node Type"]} (${node["Index Name"]})` : node["Node Type"]);
        (node.Plans ?? []).forEach(visit);
      };

      visit(plan[0].Plan);
      return nodes;
    };
    const explain = async (mode, sql, values) => {
      setMode(mode);

      const result = await asActor(() => q(`EXPLAIN (FORMAT JSON) ${sql}`, values));

      return summarizePlan(result.rows[0]["QUERY PLAN"]);
    };
    const plans = {};

    for (const mode of ["off", "enforce"]) {
      plans[mode] = {
        dense: await explain(mode, denseSql, [queryVector, actorDocIds]),
        sparse: await explain(mode, sparseSql, ["policy renewal", actorDocIds]),
      };
    }

    // --- Overhead ------------------------------------------------------------
    const operations = {
      denseSearch: () =>
        pgvector.searchPgvectorDocuments({
          docIds: actorDocIds,
          queryText: "policy renewal",
          queryVector: JSON.parse(queryVector),
          topK: 8,
        }),
      pointRead: () => store.get({ accessScope: actor, taskId: `${actor.userId}-1` }),
      sparseSearch: () =>
        pgvector.searchPgvectorSparseDocuments({
          docIds: actorDocIds,
          queryText: "policy renewal",
          topK: 8,
        }),
    };
    const samples = Object.fromEntries(
      Object.keys(operations).map((key) => [key, { enforce: [], off: [] }])
    );

    for (let iteration = 0; iteration < options.iterations + 20; iteration += 1) {
      const order = iteration % 2 === 0 ? ["off", "enforce"] : ["enforce", "off"];

      for (const [key, operation] of Object.entries(operations)) {
        for (const mode of order) {
          setMode(mode);

          const startedAt = performance.now();

          await asActor(operation);

          // The first 20 iterations warm the pool and caches.
          if (iteration >= 20) {
            samples[key][mode].push(performance.now() - startedAt);
          }
        }
      }
    }

    const overhead = Object.fromEntries(
      Object.entries(samples).map(([key, byMode]) => {
        const summary = Object.fromEntries(
          Object.entries(byMode).map(([mode, values]) => [
            mode,
            { p50Ms: round(percentile(values, 0.5), 3), p95Ms: round(percentile(values, 0.95), 3) },
          ])
        );

        return [
          key,
          {
            ...summary,
            p50DeltaMs: round(summary.enforce.p50Ms - summary.off.p50Ms, 3),
          },
        ];
      })
    );

    const isolation = {
      enforce: await runIsolationProbes("enforce"),
      off: await runIsolationProbes("off"),
    };
    const report = {
      generatedAt: new Date().toISOString(),
      corpus: {
        chunks: options.tenants * options.docsPerTenant * options.chunksPerDoc,
        chunksPerDoc: options.chunksPerDoc,
        dimensions: options.dimensions,
        docsPerTenant: options.docsPerTenant,
        seedMs: round(seedMs, 0),
        tenants: options.tenants,
      },
      database: (await q("SHOW server_version")).rows[0].server_version,
      iterations: options.iterations,
      isolation,
      overhead,
      plans,
      roundTripsPerScopedStatement: { enforce: 4, off: 1 },
    };

    const lines = [
      "# Tenant isolation (PostgreSQL row-level security)",
      "",
      `Generated ${report.generatedAt} on PostgreSQL ${report.database}; ${report.corpus.tenants} tenants, ${report.corpus.chunks} chunks (${report.corpus.dimensions}-dim), ${report.iterations} timed iterations per operation and mode.`,
      "",
      "## Isolation (acting as one tenant)",
      "",
      "| | RLS off | RLS enforce |",
      "|---|---|---|",
      `| Tables leaking foreign rows to a query without a tenant filter | ${isolation.off.leakedTables}/9 | ${isolation.enforce.leakedTables}/9 |`,
      `| Foreign rows read | ${isolation.off.foreignRowsRead} | ${isolation.enforce.foreignRowsRead} |`,
      `| Cross-tenant attacks accepted (forged insert, upsert takeover, update, delete, wrong-scope store read) | ${isolation.off.acceptedAttacks}/5 | ${isolation.enforce.acceptedAttacks}/5 |`,
      "",
      "## Overhead",
      "",
      "| Operation | off p50 / p95 (ms) | enforce p50 / p95 (ms) | p50 delta (ms) |",
      "|---|---|---|---|",
      ...Object.entries(overhead).map(
        ([key, value]) =>
          `| ${key} | ${value.off.p50Ms} / ${value.off.p95Ms} | ${value.enforce.p50Ms} / ${value.enforce.p95Ms} | ${value.p50DeltaMs} |`
      ),
      "",
      "A scoped statement costs four round trips under enforce (BEGIN, tenant settings, the statement, COMMIT) instead of one.",
      "",
      "## Plans",
      "",
      "| Query | off | enforce |",
      "|---|---|---|",
      `| dense | ${plans.off.dense.join(" > ")} | ${plans.enforce.dense.join(" > ")} |`,
      `| sparse | ${plans.off.sparse.join(" > ")} | ${plans.enforce.sparse.join(" > ")} |`,
      "",
      "The sparse row is the plain statement. Under enforce it cannot use the GIN index (@@ is not leakproof), which is why a tenant's multi-document full-text search goes through the owner-run rank function of migration 014 instead (docs/evaluation.md, \"压测与规模\"); the timed sparse series above measures that app path.",
      "",
    ];

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(
      path.join(resultsDirectory, "latest-tenant-isolation.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    await writeFile(path.join(resultsDirectory, "latest-tenant-isolation.md"), `${lines.join("\n")}\n`);
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    await modules?.postgres.resetPostgresPool();
    await adminQuery(options.databaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminQuery(options.databaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
    await adminQuery(options.databaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
  }
};

await main();
