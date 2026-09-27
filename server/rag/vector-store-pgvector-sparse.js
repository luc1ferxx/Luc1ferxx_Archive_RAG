import {
  getBm25B,
  getBm25K1,
  getDocumentChunksPostgresTable,
  getSparseCommonTermCap,
  getSparsePruneDfFraction,
  getSparseScoring,
} from "./config.js";

// The pgvector sparse route's collection statistics, Okapi BM25 and
// common-term pruning (migrations 029 and 030).
//
// Two scorings share the route. `ts_rank_cd` is PostgreSQL's cover-density
// rank over the GIN-matched chunks (migration 014 and the plain statement in
// vector-store-pgvector.js); it has no collection statistics and is never
// called BM25. `bm25` is Okapi BM25 with Lucene's always-positive IDF -- the
// same formula as the local sparse store (rag/sparse-store.js), which is its
// reference: over the same chunks and statistics both give the same scores.
//
//   score(chunk) = sum over query lexemes t in the chunk of
//                  idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avglen))
//   idf(t)       = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
//
// tf is the number of positions of t in the chunk's tsvector (PostgreSQL keeps
// at most 256 positions per lexeme, far above what a chunk holds), len the
// chunk's number of positions (sparse_length), and N, avglen and df come from
// the statistics migration 030 keeps per index version and per
// (owner_user_id, workspace_id) scope. A search scores against the scopes of
// the documents it searches, never another tenant's. Writers only append to
// the statistics log; the totals are folded from it by whichever write
// statement gets a per-table try-lock, so writers never wait on each other for
// them.
//
// Common-term pruning (RAG_SPARSE_PRUNE_DF_FRACTION, either scoring): a query
// word most chunks contain makes the GIN match nearly the whole document set,
// and every one of those chunks would be scored. With pruning the candidates
// come from the rare terms (df at most that share of the scope) and are scored
// with every term; a query with only common terms -- one word, or several --
// takes at most RAG_SPARSE_COMMON_TERM_CAP candidates per pass (every common
// term first, then any). Migration 030's header lists the paths; each result
// row names the one taken (`sparseCandidates`).

const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TEXT_SEARCH_CONFIG_PATTERN = /^[a-z_][a-z0-9_]*$/;

export const SPARSE_SCORINGS = Object.freeze({
  bm25: "bm25",
  tsRankCd: "ts_rank_cd",
});

// What describeVectorStoreRuntime and the reports call each scoring.
export const PGVECTOR_SPARSE_BACKENDS = Object.freeze({
  bm25: "postgres_bm25",
  ts_rank_cd: "postgres_fts_ts_rank_cd",
});

// The candidate paths migration 030's search function reports per row.
export const SPARSE_CANDIDATE_PATHS = Object.freeze([
  "exhaustive",
  "pruned",
  "pruned_filled",
  "common_bounded",
]);

export const PGVECTOR_SPARSE_SEARCH_SIGNATURE =
  "(tsquery, tsvector, text[], integer, text, double precision, double precision, double precision, bigint, integer)";

// Pruning applies only when the searched documents hold more chunks than this
// (their registry chunk_count): below it exhaustive scoring is cheap (one
// document of the scale benchmark: 0.5-0.8 ms). The evaluation passes 0 to
// prune small sets.
export const PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS = 1000;

// The objects migration 030 installs next to one chunk table.
export const PGVECTOR_SPARSE_TABLE_SUFFIXES = Object.freeze({
  foldFunction: "_sparse_fold",
  lengthFunction: "_sparse_length",
  scopeLog: "_sparse_scope_log",
  scopes: "_sparse_scopes",
  searchFunction: "_sparse_search",
  statsFunctionPrefix: "_sparse_stats_",
  termLog: "_sparse_term_log",
  terms: "_sparse_terms",
});

const STATS_OPERATIONS = Object.freeze(["ins", "del", "upd", "trunc"]);

const assertChunkTable = (chunkTable) => {
  const name = String(chunkTable ?? "").toLowerCase();

  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new Error(`"${chunkTable}" is not a simple PostgreSQL table name.`);
  }

  for (const derived of [
    `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.scopes}_pkey`,
    `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.terms}_pkey`,
    `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.scopeLog}_idx`,
    `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.termLog}_idx`,
    `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.statsFunctionPrefix}trunc`,
  ]) {
    if (Buffer.byteLength(derived, "utf8") > 63) {
      throw new Error(`The sparse statistics object name "${derived}" would exceed PostgreSQL's 63 bytes.`);
    }
  }

  return name;
};

export const getPgvectorSparseSearchFunctionName = (chunkTable) =>
  `${assertChunkTable(chunkTable)}${PGVECTOR_SPARSE_TABLE_SUFFIXES.searchFunction}`;

export const getPgvectorSparseFoldFunctionName = (chunkTable) =>
  `${assertChunkTable(chunkTable)}${PGVECTOR_SPARSE_TABLE_SUFFIXES.foldFunction}`;

/** The four statistics tables of one chunk table: folded totals and the append-only log. */
export const getPgvectorSparseStatisticsTables = (chunkTable) => {
  const name = assertChunkTable(chunkTable);

  return {
    scopeLog: `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.scopeLog}`,
    scopes: `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.scopes}`,
    termLog: `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.termLog}`,
    terms: `${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.terms}`,
  };
};

/** The owner-only installer migration 030 creates, named after the migration-012 table. */
export const getPgvectorBm25InstallFunctionName = () =>
  `${assertChunkTable(getDocumentChunksPostgresTable())}_install_bm25`;

/**
 * The statement that gives a new index version's table its statistics,
 * triggers and search function. It runs in the transaction that creates the
 * table, right after the table DDL (vector-store-pgvector-version-lifecycle.js).
 */
export const renderPgvectorBm25InstallStatement = ({ chunkTable, textSearchConfig }) => {
  const name = assertChunkTable(chunkTable);
  const config = String(textSearchConfig ?? "").trim();

  if (!TEXT_SEARCH_CONFIG_PATTERN.test(config)) {
    throw new Error(`"${textSearchConfig}" is not a simple text search configuration name.`);
  }

  return `SELECT ${getPgvectorBm25InstallFunctionName()}('${name}', '${config}'::regconfig);`;
};

/** Drops what migration 030 installed next to a retired version's table (after the table). */
export const renderPgvectorBm25DropDdl = ({ chunkTable }) => {
  const name = assertChunkTable(chunkTable);
  const { scopeLog, scopes, termLog, terms } = getPgvectorSparseStatisticsTables(name);

  return [
    `DROP FUNCTION IF EXISTS ${getPgvectorSparseSearchFunctionName(name)}${PGVECTOR_SPARSE_SEARCH_SIGNATURE};`,
    ...STATS_OPERATIONS.map(
      (operation) =>
        `DROP FUNCTION IF EXISTS ${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.statsFunctionPrefix}${operation}();`
    ),
    `DROP FUNCTION IF EXISTS ${getPgvectorSparseFoldFunctionName(name)}();`,
    `DROP FUNCTION IF EXISTS ${name}${PGVECTOR_SPARSE_TABLE_SUFFIXES.lengthFunction}();`,
    `DROP TABLE IF EXISTS ${termLog};`,
    `DROP TABLE IF EXISTS ${scopeLog};`,
    `DROP TABLE IF EXISTS ${terms};`,
    `DROP TABLE IF EXISTS ${scopes};`,
  ].join("\n");
};

/**
 * The scoring and candidate settings of one sparse search: the configuration,
 * unless the caller (an evaluation arm, the benchmark) names them.
 * `pruneDfFraction` / `commonTermCap` null mean exhaustive / uncapped.
 */
export const resolvePgvectorSparseScoring = ({ commonTermCap, pruneDfFraction, pruneMinChunks, scoring } = {}) => {
  const resolved = scoring === undefined || scoring === null ? getSparseScoring() : String(scoring).trim().toLowerCase();

  if (!Object.values(SPARSE_SCORINGS).includes(resolved)) {
    throw new Error(`Unknown sparse scoring "${scoring}".`);
  }

  const fraction = pruneDfFraction === undefined ? getSparsePruneDfFraction() : pruneDfFraction;
  const cap = commonTermCap === undefined ? getSparseCommonTermCap() : commonTermCap;

  return {
    b: getBm25B(),
    commonTermCap: Number.isInteger(cap) && cap > 0 ? cap : null,
    k1: getBm25K1(),
    pruneDfFraction: Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? fraction : null,
    pruneMinChunks:
      Number.isInteger(pruneMinChunks) && pruneMinChunks >= 0 ? pruneMinChunks : PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS,
    scoring: resolved,
  };
};

/**
 * Whether a search goes through migration 030's search function: always for
 * BM25; for ts_rank_cd only when pruning is on and several documents are
 * searched (one document keeps the plain statement, whose doc_id index scan
 * is the cheapest plan and whose chunks are far below the pruning minimum).
 */
export const usesPgvectorSparseSearchFunction = ({ docCount, options }) =>
  options.scoring === SPARSE_SCORINGS.bm25 || (options.pruneDfFraction !== null && docCount > 1);

export const getPgvectorSparseBackend = (scoring = getSparseScoring()) =>
  PGVECTOR_SPARSE_BACKENDS[scoring] ?? PGVECTOR_SPARSE_BACKENDS.ts_rank_cd;

/**
 * One statement for every caller, tenant or owner, one document or many: the
 * search function takes the document ids (and, under the tenant role, keeps
 * only those the tenant policy lets it read), and the join back to the chunk
 * table runs as the caller, so the row policies still decide which rows
 * return. $1 text search configuration, $2 the OR tsquery, $3 the query terms,
 * $4 doc ids, $5 limit, $6 scoring, $7 k1, $8 b, $9 prune fraction (NULL:
 * exhaustive), $10 the chunk count below which the documents are scored
 * exhaustively, $11 the common-term candidate cap (NULL: none).
 */
export const buildPgvectorSparseSearchSql = ({ chunkTable }) => `
  SELECT c.chunk_id, c.doc_id, c.chunk_index, c.page_number, c.section_heading, c.content, c.metadata,
         r.sparse_score, r.candidate_mode
  FROM ${getPgvectorSparseSearchFunctionName(chunkTable)}(
         to_tsquery($1::regconfig, $2),
         to_tsvector($1::regconfig, $3),
         $4::text[],
         $5::integer,
         $6::text,
         $7::double precision,
         $8::double precision,
         $9::double precision,
         $10::bigint,
         $11::integer
       ) AS r
  JOIN ${assertChunkTable(chunkTable)} c ON c.chunk_id = r.chunk_id
  ORDER BY r.sparse_score DESC, c.chunk_id ASC
`;

export const buildPgvectorSparseSearchValues = ({ docIds, limit, options, textSearchConfig, tsQuery, tokens }) => [
  textSearchConfig,
  tsQuery,
  tokens.join(" "),
  docIds,
  limit,
  options.scoring,
  options.k1,
  options.b,
  options.pruneDfFraction,
  options.pruneMinChunks,
  options.commonTermCap,
];

/**
 * A chunk table's statistics as a search sees them (folded totals plus the
 * unfolded log), for tests, the evaluation and the benchmark: per scope the
 * chunk count and total length, and the document frequency of `lexemes`
 * (every lexeme when null).
 */
export const readPgvectorSparseStatistics = async ({ chunkTable, lexemes = null, query, scope = null }) => {
  const { scopeLog, scopes, termLog, terms } = getPgvectorSparseStatisticsTables(chunkTable);
  const scopeFilter = scope ? "WHERE owner_user_id = $1 AND workspace_id = $2" : "";
  const scopeValues = scope ? [scope.userId ?? "", scope.workspaceId ?? ""] : [];
  const scopeRows = await query(
    `SELECT owner_user_id, workspace_id, sum(chunk_count)::bigint AS chunk_count, sum(total_length)::bigint AS total_length
     FROM (SELECT owner_user_id, workspace_id, chunk_count, total_length FROM ${scopes}
           UNION ALL
           SELECT owner_user_id, workspace_id, chunk_delta, length_delta FROM ${scopeLog}) AS x
     ${scopeFilter}
     GROUP BY 1, 2
     HAVING sum(chunk_count) <> 0 OR sum(total_length) <> 0
     ORDER BY owner_user_id COLLATE "C", workspace_id COLLATE "C"`,
    scopeValues
  );
  const termValues = [...scopeValues];
  const termFilters = [];

  if (scope) {
    termFilters.push("owner_user_id = $1 AND workspace_id = $2");
  }

  if (Array.isArray(lexemes)) {
    termValues.push(lexemes);
    termFilters.push(`lexeme = ANY($${termValues.length}::text[])`);
  }

  const termRows = await query(
    `SELECT owner_user_id, workspace_id, lexeme, sum(doc_freq)::bigint AS doc_freq
     FROM (SELECT owner_user_id, workspace_id, lexeme, doc_freq FROM ${terms}
           UNION ALL
           SELECT owner_user_id, workspace_id, lexeme, df_delta FROM ${termLog}) AS x
     ${termFilters.length > 0 ? `WHERE ${termFilters.join(" AND ")}` : ""}
     GROUP BY 1, 2, 3
     HAVING sum(doc_freq) <> 0
     ORDER BY owner_user_id COLLATE "C", workspace_id COLLATE "C", lexeme COLLATE "C"`,
    termValues
  );

  return {
    scopes: scopeRows.rows.map((row) => ({
      chunkCount: Number(row.chunk_count),
      ownerUserId: row.owner_user_id,
      totalLength: Number(row.total_length),
      workspaceId: row.workspace_id,
    })),
    terms: termRows.rows.map((row) => ({
      docFreq: Number(row.doc_freq),
      lexeme: row.lexeme,
      ownerUserId: row.owner_user_id,
      workspaceId: row.workspace_id,
    })),
  };
};

// A version created by a process that predates migration 030 has no search
// function (42883), and a tenant role without its grant cannot call it
// (42501): fail with the remedy rather than PostgreSQL's bare code.
export const toMissingSparseSearchFunctionError = (error, chunkTable) => {
  const missing = error?.code === "42883";
  const denied = error?.code === "42501";

  if (
    !(missing || denied) ||
    !String(error?.message ?? "").includes(PGVECTOR_SPARSE_TABLE_SUFFIXES.searchFunction)
  ) {
    return error;
  }

  const wrapped = new Error(
    missing
      ? `The sparse search function for ${chunkTable} does not exist (migration 030 installs it for every live index version). ` +
          "Run the migrations, rebuild the version with `npm run vector:index -- build`, or set RAG_SPARSE_SCORING=ts_rank_cd and RAG_SPARSE_PRUNE_DF_FRACTION=off."
      : `The tenant role may not execute the sparse search function for ${chunkTable} (migration 030 grants it). ` +
          "Run the migrations again after changing POSTGRES_TENANT_ROLE or restoring the database; checks.rowLevelSecurity reports the missing grant."
  );

  wrapped.code = "PGVECTOR_SPARSE_SEARCH_UNAVAILABLE";
  wrapped.status = 503;
  wrapped.cause = error;
  return wrapped;
};

/**
 * Fills sparse_length on rows written before migration 029, in batches of
 * `batchSize` rows per short transaction, each with `lock_timeout` so a batch
 * that meets a writer's row locks skips them (SKIP LOCKED) instead of queuing.
 * Resumable: every batch commits on its own and the next run starts over the
 * rows still NULL. The value is the one the NULL stood for (the tsvector's
 * position count), so the statistics are unchanged and the statement trigger
 * logs nothing for these rows. Each updated row gets a new version, which
 * every index of the table -- HNSW included -- indexes again: plan it like a
 * reindex. `withTransaction(callback)` runs `callback(query)` in one
 * transaction as the table owner.
 */
export const backfillPgvectorSparseLength = async ({
  batchSize = 500,
  chunkTables,
  dryRun = false,
  lockTimeoutMs = 2000,
  maxBatches = Number.POSITIVE_INFINITY,
  onBatch = null,
  query,
  withTransaction,
}) => {
  const size = Math.max(1, Math.floor(Number(batchSize) || 500));
  const timeout = Math.max(1, Math.floor(Number(lockTimeoutMs) || 2000));
  const tables = [...new Set(chunkTables.map((table) => assertChunkTable(table)))];
  const report = [];

  for (const table of tables) {
    const missing = async () =>
      Number((await query(`SELECT count(*)::bigint AS missing FROM ${table} WHERE sparse_length IS NULL`)).rows[0]?.missing) || 0;
    const before = await missing();
    let updated = 0;
    let batches = 0;

    while (!dryRun && batches < maxBatches) {
      const count = await withTransaction(async (transactionQuery) => {
        await transactionQuery("SELECT set_config('lock_timeout', $1, true)", [`${timeout}ms`]);

        const result = await transactionQuery(
          `/* sparse_length:backfill */
            UPDATE ${table} AS c
               SET sparse_length = (SELECT coalesce(sum(coalesce(cardinality(u.positions), 1)), 0)::integer
                                      FROM unnest(c.search_vector) AS u)
             WHERE c.chunk_id IN (
               SELECT n.chunk_id FROM ${table} AS n
                WHERE n.sparse_length IS NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
             )`,
          [size]
        );

        return result.rowCount ?? 0;
      });

      batches += 1;
      updated += count;
      onBatch?.({ batches, table, updated });

      if (count === 0) {
        break;
      }
    }

    report.push({ batches, missingAfter: dryRun ? before : await missing(), missingBefore: before, table, updated });
  }

  return report;
};
