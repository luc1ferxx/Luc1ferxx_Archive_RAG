import assert from "node:assert/strict";
import test from "node:test";

import {
  NODE_STATEMENT_KINDS,
  buildAppEnvironment,
  classifyNodeStatement,
  diffNodeStatements,
  diffReplicaRouting,
  formatReadReplica,
  parseLoadTestArgs,
  summarizeNodeStatements,
  sumReplicaRouting,
} from "../evaluation/run-api-load-bench.mjs";

// The load harness's --read-replica-url (scripts/run-load-test-pgvector.sh
// --read-replica provisions the replica): option checks, the app environment
// it produces, and the per-node statement and routing summaries the report is
// built from. Running it needs a disposable primary and replica; that is a
// smoke run of the wrapper, not part of this suite.

const DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:6000/loadtest";
const REPLICA_URL = "postgresql://postgres:postgres@127.0.0.1:6001/loadtest";

test("--read-replica-url needs pgvector storage and --tenant", () => {
  const options = parseLoadTestArgs([
    "--database-url",
    DATABASE_URL,
    "--storage",
    "pgvector",
    "--tenant",
    "--read-replica-url",
    REPLICA_URL,
  ]);

  assert.equal(options.readReplicaUrl, REPLICA_URL);
  assert.equal(parseLoadTestArgs([]).readReplicaUrl, "");
  assert.throws(
    () => parseLoadTestArgs(["--database-url", DATABASE_URL, "--storage", "pgvector", "--read-replica-url", REPLICA_URL]),
    /needs --tenant/
  );
  assert.throws(
    () => parseLoadTestArgs(["--storage", "local", "--tenant", "--read-replica-url", REPLICA_URL]),
    /needs --storage pgvector/
  );
});

test("the pgvector app processes get POSTGRES_READ_REPLICA_URLS; nothing else does, and a shell's value never leaks in", () => {
  const options = parseLoadTestArgs([
    "--database-url",
    DATABASE_URL,
    "--storage",
    "pgvector",
    "--tenant",
    "--read-replica-url",
    REPLICA_URL,
  ]);
  const base = { PATH: "/usr/bin", POSTGRES_READ_REPLICA_URLS: "postgresql://prod-replica/archive" };
  const pgvector = buildAppEnvironment({
    baseEnvironment: base,
    databaseUrl: DATABASE_URL,
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options,
    storage: "pgvector",
    tempRoot: "/tmp/load",
  });
  const local = buildAppEnvironment({
    baseEnvironment: base,
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options,
    storage: "local",
    tempRoot: "/tmp/load",
  });
  const withoutReplica = buildAppEnvironment({
    baseEnvironment: base,
    databaseUrl: DATABASE_URL,
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: { ...options, readReplicaUrl: "" },
    storage: "pgvector",
    tempRoot: "/tmp/load",
  });

  assert.equal(pgvector.POSTGRES_READ_REPLICA_URLS, REPLICA_URL);
  assert.equal(local.POSTGRES_READ_REPLICA_URLS, undefined);
  assert.equal(withoutReplica.POSTGRES_READ_REPLICA_URLS, undefined);
});

test("pg_stat_statements entries are classified by what a replica can take", () => {
  const cases = {
    "SELECT set_config($4, $1, $5), set_config($6, $2, $7), set_config($8, $3, $9)": "tenantSettings",
    "SELECT (CASE WHEN ( SELECT count(*) FROM unnest($1::text[], $2::integer[]) AS expected(doc_id, content_version) JOIN rag_documents d ON true) = $3 THEN $4 ELSE $5 END)::integer AS fresh": "guard",
    "SELECT chunk_id, 1 - (embedding <=> $1::vector) AS vector_score FROM rag_document_chunks": "search",
    "SELECT c.chunk_id FROM rag_document_chunks_sparse_search(to_tsquery($1::regconfig, $2)) AS r": "search",
    "SELECT pg_is_in_recovery() AS in_recovery, pg_last_wal_replay_lsn()::text AS replay_lsn": "monitor",
    "SELECT pg_current_wal_flush_lsn()::text AS lsn": "monitor",
    "SELECT doc_id FROM rag_documents WHERE doc_id = ANY($1::text[])": "otherRead",
    "WITH run_events AS (SELECT 1) SELECT * FROM run_events": "otherRead",
    "INSERT INTO rag_agent_runs (run_id) VALUES ($1)": "writeOrUtility",
    "WITH updated AS (UPDATE rag_agent_runs SET revision = $1 RETURNING *) SELECT * FROM updated": "writeOrUtility",
    "SELECT * FROM rag_documents WHERE doc_id = $1 FOR UPDATE": "writeOrUtility",
    ANALYZE: "writeOrUtility",
    BEGIN: "transaction",
    COMMIT: "transaction",
  };

  for (const [query, kind] of Object.entries(cases)) {
    assert.equal(classifyNodeStatement(query), kind, query);
  }
});

test("per-node counts sum calls by kind, skip the harness's own reads, and diff without going negative", () => {
  const before = summarizeNodeStatements([
    { calls: "3", query: "SELECT chunk_id, 1 - (embedding <=> $1::vector) AS vector_score FROM t" },
    { calls: 2, query: "INSERT INTO t VALUES ($1)" },
    { calls: 9, query: "SELECT s.query, s.calls FROM pg_stat_statements s" },
  ]);

  assert.deepEqual(Object.keys(before), [...NODE_STATEMENT_KINDS, "total"]);
  assert.equal(before.search, 3);
  assert.equal(before.writeOrUtility, 2);
  assert.equal(before.total, 5);

  const after = summarizeNodeStatements([
    { calls: 10, query: "SELECT chunk_id, 1 - (embedding <=> $1::vector) AS vector_score FROM t" },
  ]);
  const diff = diffNodeStatements(before, after);

  assert.equal(diff.search, 7);
  assert.equal(diff.writeOrUtility, 0, "an evicted entry never counts negative");
});

test("routing counters are summed over processes and diffed over the window", () => {
  const snapshot = (replica, primary, versionBehind) => ({
    bypasses: { in_transaction: 0, owner: 1 },
    enabled: true,
    fallbacks: { lag_exceeded: 0, version_behind: versionBehind },
    reads: { primary, replica },
  });
  const before = sumReplicaRouting([snapshot(2, 1, 0), { enabled: false }, null]);
  const after = sumReplicaRouting([snapshot(10, 3, 1), snapshot(4, 0, 0)]);

  assert.deepEqual(before.reads, { primary: 1, replica: 2 });
  assert.equal(before.processes, 1);
  assert.deepEqual(diffReplicaRouting(before, after), {
    bypasses: { in_transaction: 0, owner: 1 },
    fallbacks: { lag_exceeded: 0, version_behind: 1 },
    processes: 2,
    reads: { primary: 2, replica: 12 },
  });
});

test("the report section names the replica by host and port and shows both nodes' statements", () => {
  const statements = summarizeNodeStatements([
    { calls: 4, query: "SELECT chunk_id, 1 - (embedding <=> $1::vector) AS vector_score FROM t" },
  ]);
  const lines = formatReadReplica({
    endpoint: "127.0.0.1:6001",
    routing: { total: { fallbacks: { version_behind: 2 }, reads: { primary: 2, replica: 4 } } },
    statements: { primary: summarizeNodeStatements([]), replica: statements },
  }).join("\n");

  assert.match(lines, /streaming replica at 127\.0\.0\.1:6001/);
  assert.match(lines, /4 read\(s\) to the replica and 2 marked read\(s\) to the primary \(fallbacks: version_behind 2\)/);
  assert.match(lines, /\| replica \| 4 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 4 \|/);
  assert.ok(!lines.includes("postgres:postgres"));
  assert.deepEqual(formatReadReplica(null), []);
});
