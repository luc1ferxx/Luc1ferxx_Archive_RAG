-- Collection statistics for the pgvector sparse route: Okapi BM25
-- (RAG_SPARSE_SCORING=bm25) and common-term pruning for either scoring.
--
-- The lexical route ranked with ts_rank_cd, PostgreSQL's cover-density rank,
-- which is not BM25 and has no collection statistics. BM25 needs, for the
-- collection a query is scored against, the number of chunks, their average
-- length and each query term's document frequency; pruning needs the document
-- frequencies too. This migration installs, for one chunk table:
--
--   <t>_sparse_scope_log  append-only (owner_user_id, workspace_id, chunk_delta,
--   <t>_sparse_term_log   length_delta) and (owner_user_id, workspace_id,
--                         lexeme, df_delta) rows: what each write statement
--                         changed. No primary key, no unique index, no update:
--                         concurrent writers only ever insert new rows, so a
--                         writer never waits on another writer for the
--                         statistics and no two writers can deadlock on them,
--                         whatever order they write the version tables in.
--   <t>_sparse_scopes     the folded totals per (owner_user_id, workspace_id):
--   <t>_sparse_terms      chunk count and total length, and per lexeme the
--                         document frequency (chunks whose tsvector holds it).
--                         Only the fold writes them.
--   <t>_sparse_fold()     moves every committed log row into the totals. It
--                         runs only under pg_try_advisory_xact_lock: the write
--                         statement that gets the lock folds (and keeps the lock
--                         to its COMMIT), every other one skips without waiting.
--                         One folder at a time, and the folder waits on nothing:
--                         the log rows it deletes are committed and no one else
--                         deletes them, the totals rows are written by folders
--                         only. The log therefore holds at most what writers
--                         committed since the last fold plus what is in flight.
--   <t>_sparse_length     BEFORE row trigger: sparse_length (migration 029) is the
--                         number of positions in to_tsvector(search_text) with the
--                         table's text search configuration.
--   <t>_sparse_stats_*    statement-level AFTER INSERT / UPDATE / DELETE /
--                         TRUNCATE triggers with transition tables: append the
--                         statement's deltas, then try to fold. Every writer
--                         goes through them: ingest, replacement, delete, clear,
--                         a document's cascading delete, the index-version
--                         builder, the reindex and a benchmark's bulk load
--                         alike. An updated row whose tsvector and scope stay
--                         (the sparse_length backfill) is left out.
--   <t>_sparse_search(...) the owner-run ranking function (below).
--
-- A search reads totals plus the unfolded log under one snapshot, which is
-- exactly what its snapshot's chunk rows hold: every writer commits its log
-- rows with its chunk rows, and a fold moves rows atomically.
--
-- Cost of a delete: its statement expands every deleted chunk's tsvector into
-- lexemes (and counts positions where sparse_length is NULL) to log the
-- negative document frequencies, and the transition table holds every
-- deleted row. A clear of a large archive pays that inside its transaction:
-- on the scale benchmark (100k chunks) a cascading delete took 25 ms per
-- 1,000 chunks against 4.4 without the triggers, 43 against 8.6 with
-- sparse_length NULL. sparse-length-backfill.mjs fills sparse_length on rows
-- written before migration 029 so the length need not be recounted. Writers
-- pay the log inserts: one 50-chunk ingest 336 against 317 ms (p50), and four
-- same-scope writers 10.4 against 11.1 documents/s -- they scale as without
-- the triggers, where the previous per-scope counter row serialized them.
--
-- Every index version's table gets the same objects: the version builder calls
-- <base>_install_bm25 for the table it creates, and this migration calls it for
-- the migration-012 table and for every live version's table. Retiring a
-- version drops them with its table (rag/vector-store-pgvector-sparse.js).
--
-- Row-level security: the four statistics tables carry migration 013's
-- tenant_isolation policy but no grant: a tenant never reads or writes them
-- directly. The triggers and the fold run as the owner (SECURITY DEFINER) on
-- rows the writing statement changed, which already passed the chunk table's
-- policy. The search function reads them as the owner for the scopes of the
-- documents it was given, and filters those documents by the same policy
-- predicate when the caller acts as the tenant role, so calling it directly
-- with another tenant's document ids returns nothing.
--
-- Existing rows: this migration folds the stored tsvectors into the totals
-- (one aggregation over the table, under a SHARE ROW EXCLUSIVE lock that blocks
-- writers, not readers). sparse_length stays NULL on rows written before
-- migration 029 until sparse-length-backfill.mjs fills it; until then BM25
-- counts those rows' positions when it scores them.

CREATE OR REPLACE FUNCTION __DOCUMENT_CHUNKS_TABLE___install_bm25(target_table text, text_search_config regconfig)
RETURNS void
LANGUAGE plpgsql
AS $install$
DECLARE
  schema_name CONSTANT text := current_schema();
  tenant_role CONSTANT text := '__TENANT_ROLE__';
  documents_table CONSTANT text := lower('__DOCUMENTS_TABLE__');
  chunk_table CONSTANT text := lower(target_table);
  qualified_chunks CONSTANT text := format('%I.%I', current_schema(), lower(target_table));
  scopes_table CONSTANT text := lower(target_table) || '_sparse_scopes';
  terms_table CONSTANT text := lower(target_table) || '_sparse_terms';
  scope_log_table CONSTANT text := lower(target_table) || '_sparse_scope_log';
  term_log_table CONSTANT text := lower(target_table) || '_sparse_term_log';
  length_function CONSTANT text := lower(target_table) || '_sparse_length';
  stats_prefix CONSTANT text := lower(target_table) || '_sparse_stats_';
  fold_function CONSTANT text := lower(target_table) || '_sparse_fold';
  search_function CONSTANT text := lower(target_table) || '_sparse_search';
  search_signature CONSTANT text :=
    '(tsquery, tsvector, text[], integer, text, double precision, double precision, double precision, bigint, integer)';
  policy_predicate CONSTANT text := $policy$
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  $policy$;
  -- One statistics trigger body; %4$s is the statement's changed rows as
  -- (owner_user_id, workspace_id, search_vector, sparse_length, sign).
  stats_body CONSTANT text := $stats$
BEGIN
  IF NOT EXISTS (%4$s) THEN
    RETURN NULL;
  END IF;

  INSERT INTO %1$I.%2$I (owner_user_id, workspace_id, chunk_delta, length_delta)
  SELECT c.owner_user_id, c.workspace_id,
         sum(c.sign)::bigint,
         sum(c.sign * coalesce(
           c.sparse_length,
           (SELECT sum(coalesce(cardinality(u.positions), 1)) FROM unnest(c.search_vector) AS u),
           0
         ))::bigint
  FROM (%4$s) AS c
  GROUP BY c.owner_user_id, c.workspace_id;

  INSERT INTO %1$I.%3$I (owner_user_id, workspace_id, lexeme, df_delta)
  SELECT c.owner_user_id, c.workspace_id, l.lexeme, sum(c.sign)::bigint
  FROM (%4$s) AS c
  CROSS JOIN LATERAL unnest(tsvector_to_array(c.search_vector)) AS l(lexeme)
  GROUP BY c.owner_user_id, c.workspace_id, l.lexeme
  HAVING sum(c.sign) <> 0;

  PERFORM %1$I.%5$I();
  RETURN NULL;
END
$stats$;
  -- The fold. %1$I schema, %2$I scopes, %3$I terms, %4$I scope log, %5$I term
  -- log, %6$s the advisory lock key.
  fold_body CONSTANT text := $fold$
DECLARE
  emptied_owners text[];
  emptied_workspaces text[];
  zero_owners text[];
  zero_workspaces text[];
  zero_lexemes text[];
BEGIN
  IF NOT pg_try_advisory_xact_lock((%6$s)::bigint) THEN
    RETURN false;
  END IF;

  WITH moved AS (
    DELETE FROM %1$I.%4$I RETURNING owner_user_id, workspace_id, chunk_delta, length_delta
  ),
  delta AS (
    SELECT m.owner_user_id, m.workspace_id,
           sum(m.chunk_delta)::bigint AS chunk_delta, sum(m.length_delta)::bigint AS length_delta
    FROM moved AS m
    GROUP BY m.owner_user_id, m.workspace_id
    HAVING sum(m.chunk_delta) <> 0 OR sum(m.length_delta) <> 0
  ),
  applied AS (
    INSERT INTO %1$I.%2$I AS s (owner_user_id, workspace_id, chunk_count, total_length)
    SELECT d.owner_user_id, d.workspace_id, d.chunk_delta, d.length_delta
    FROM delta AS d
    ON CONFLICT (owner_user_id, workspace_id) DO UPDATE
      SET chunk_count = s.chunk_count + EXCLUDED.chunk_count,
          total_length = s.total_length + EXCLUDED.total_length
    RETURNING s.owner_user_id, s.workspace_id, s.chunk_count
  )
  SELECT array_agg(a.owner_user_id), array_agg(a.workspace_id)
    INTO emptied_owners, emptied_workspaces
  FROM applied AS a
  WHERE a.chunk_count <= 0;

  IF emptied_owners IS NOT NULL THEN
    DELETE FROM %1$I.%2$I AS s
    USING unnest(emptied_owners, emptied_workspaces) AS e(owner_user_id, workspace_id)
    WHERE s.owner_user_id = e.owner_user_id AND s.workspace_id = e.workspace_id AND s.chunk_count <= 0;
  END IF;

  WITH moved AS (
    DELETE FROM %1$I.%5$I RETURNING owner_user_id, workspace_id, lexeme, df_delta
  ),
  delta AS (
    SELECT m.owner_user_id, m.workspace_id, m.lexeme, sum(m.df_delta)::bigint AS df_delta
    FROM moved AS m
    GROUP BY m.owner_user_id, m.workspace_id, m.lexeme
    HAVING sum(m.df_delta) <> 0
  ),
  applied AS (
    INSERT INTO %1$I.%3$I AS t (owner_user_id, workspace_id, lexeme, doc_freq)
    SELECT d.owner_user_id, d.workspace_id, d.lexeme, d.df_delta
    FROM delta AS d
    ON CONFLICT (owner_user_id, workspace_id, lexeme) DO UPDATE
      SET doc_freq = t.doc_freq + EXCLUDED.doc_freq
    RETURNING t.owner_user_id, t.workspace_id, t.lexeme, t.doc_freq
  )
  SELECT array_agg(a.owner_user_id), array_agg(a.workspace_id), array_agg(a.lexeme)
    INTO zero_owners, zero_workspaces, zero_lexemes
  FROM applied AS a
  WHERE a.doc_freq <= 0;

  IF zero_lexemes IS NOT NULL THEN
    DELETE FROM %1$I.%3$I AS t
    USING unnest(zero_owners, zero_workspaces, zero_lexemes) AS z(owner_user_id, workspace_id, lexeme)
    WHERE t.owner_user_id = z.owner_user_id
      AND t.workspace_id = z.workspace_id
      AND t.lexeme = z.lexeme
      AND t.doc_freq <= 0;
  END IF;

  RETURN true;
END
$fold$;
  -- The search function. %1$I schema, %2$I documents, %3$I scopes, %4$I terms,
  -- %5$L the qualified chunk table, %6$L the tenant role, %7$I scope log,
  -- %8$I term log.
  --
  -- Scoring: 'ts_rank_cd' (cover density with normalization 32, the
  -- statement migration 014 ranks with, never called BM25) or 'bm25' (Okapi
  -- BM25 with Lucene's always-positive IDF, the formula rag/sparse-store.js
  -- uses; statistics of the searched documents' scopes).
  --
  -- Candidates. Exhaustive: every chunk of the documents matching any query
  -- term. With pruning (prune_df_fraction in (0, 1) and the documents holding
  -- more than prune_min_chunks chunks by their registry chunk_count), a query
  -- term is common when more than that share of its scope's chunks hold it:
  --   * no common term: exhaustive;
  --   * some rare terms: every chunk matching a rare term ('pruned'); when
  --     those are fewer than max_rows, the rest come from the common terms as
  --     below ('pruned_filled');
  --   * only common terms, one or several ('common_bounded'): the chunks
  --     holding any of them, at most common_term_cap in physical order; when
  --     their scope document frequencies add up to more than the cap (so the
  --     cap may cut), the chunks holding every common term go first. NULL
  --     cap, or frequencies within it: every match is scored, exactly as
  --     exhaustive scoring would.
  -- Every candidate is scored with every query term. A result differs from the
  -- exhaustive one only where a chunk without a rare term would have ranked
  -- inside the top max_rows, or a capped pass left out a better chunk;
  -- evaluation/run-sparse-scoring-eval.mjs and the scale benchmark count it.
  search_body CONSTANT text := $search$
DECLARE
  query_lexemes CONSTANT text[] := tsvector_to_array(query_vector);
  tenant_scoped CONSTANT boolean := current_setting('role') = %6$L;
  use_bm25 CONSTANT boolean := scoring = 'bm25';
  capped CONSTANT boolean := common_term_cap IS NOT NULL AND common_term_cap > 0;
  prune boolean := false;
  allowed_doc_ids text[];
  key_owners text[];
  key_workspaces text[];
  set_chunks bigint := 0;
  chunk_total double precision := 0;
  length_total double precision := 0;
  average_length double precision := 1;
  lexemes text[] := query_lexemes;
  dfs double precision[];
  idfs double precision[];
  rare_lexemes text[] := '{}';
  common_lexemes text[] := '{}';
  common_df_total double precision := 0;
  candidates_path text := 'exhaustive';
  found_ids text[] := '{}';
  found_scores double precision[] := '{}';
  more_ids text[];
  more_scores double precision[];
  -- The candidates of one pass: the documents' chunks matching $1, less the
  -- ids $9 an earlier pass took. A capped pass reads them through a
  -- MATERIALIZED CTE, which is planned for every row (the GIN and doc_id
  -- bitmaps, as an exhaustive pass) but read lazily, so it stops at the cap;
  -- a plain LIMIT made the planner scan the doc_id index and test @@ row by
  -- row, decompressing chunks that do not match.
  candidates CONSTANT text :=
    '(SELECT c0.chunk_id, c0.search_vector, c0.sparse_length FROM ' || %5$L || ' AS c0
       WHERE c0.doc_id = ANY ($2) AND c0.search_vector @@ $1 AND NOT (c0.chunk_id = ANY ($9)))';
  -- %%1$s: the capped pass's WITH clause or nothing; %%2$s: the candidates.
  bm25_sql CONSTANT text :=
    '%%1$s SELECT array_agg(q.chunk_id ORDER BY q.score DESC, q.chunk_id),
            array_agg(q.score ORDER BY q.score DESC, q.chunk_id)
       FROM (SELECT c.chunk_id, s.score
               FROM %%2$s AS c
               CROSS JOIN LATERAL (
                 SELECT sum(w.idf * f.tf * ($5 + 1)
                            / (f.tf + $5 * (1 - $6 + $6 * coalesce(
                                c.sparse_length::double precision,
                                (SELECT sum(coalesce(cardinality(u.positions), 1))
                                   FROM unnest(c.search_vector) AS u)::double precision,
                                0) / $7))) AS score
                   FROM (SELECT v.lexeme, coalesce(cardinality(v.positions), 1)::double precision AS tf
                           FROM unnest(ts_filter(setweight(c.search_vector, ''A'', $3), ''{a}'')) AS v) AS f
                   JOIN unnest($3, $4) AS w(lexeme, idf) ON w.lexeme = f.lexeme
               ) AS s
              ORDER BY s.score DESC, c.chunk_id ASC
              LIMIT $8) AS q';
  -- ts_rank_cd is real, ranked once per row (ORDER BY 2); the outer
  -- ::text::double precision keeps each value a real's shortest decimal, the
  -- number the plain statement returns.
  rank_cd_sql CONSTANT text :=
    '%%1$s SELECT array_agg(q.chunk_id ORDER BY q.score DESC, q.chunk_id),
            array_agg(q.score ORDER BY q.score DESC, q.chunk_id)
       FROM (SELECT r.chunk_id, r.rank::text::double precision AS score
               FROM (SELECT c.chunk_id, ts_rank_cd(c.search_vector, $10, 32) AS rank
                       FROM %%2$s AS c
                      ORDER BY 2 DESC, c.chunk_id ASC
                      LIMIT $8) AS r) AS q';
  score_sql text;
  parallel_workers text;
BEGIN
  IF scoring IS NULL OR scoring NOT IN ('bm25', 'ts_rank_cd') THEN
    RAISE EXCEPTION 'sparse_search: unknown scoring "%%"', scoring;
  END IF;

  IF max_rows IS NULL OR max_rows < 1
     OR coalesce(cardinality(query_lexemes), 0) = 0
     OR coalesce(cardinality(doc_ids), 0) = 0 THEN
    RETURN;
  END IF;

  -- The documents the caller may read (the tenant policy's own predicate when
  -- it acts as the tenant role) and the scopes their statistics live in.
  WITH allowed AS MATERIALIZED (
    SELECT d.doc_id, d.owner_user_id, d.workspace_id, d.chunk_count
    FROM %1$I.%2$I AS d
    WHERE d.doc_id = ANY (doc_ids)
      AND (NOT tenant_scoped OR (
        (d.owner_user_id <> '' OR d.workspace_id <> '')
        AND (d.owner_user_id = '' OR d.owner_user_id = current_setting('archive_rag.user_id', true))
        AND (d.workspace_id = '' OR d.workspace_id = current_setting('archive_rag.workspace_id', true))
      ))
  ),
  scope_keys AS (
    SELECT DISTINCT a.owner_user_id, a.workspace_id FROM allowed AS a
  )
  SELECT (SELECT array_agg(a.doc_id) FROM allowed AS a),
         (SELECT array_agg(k.owner_user_id ORDER BY k.owner_user_id, k.workspace_id) FROM scope_keys AS k),
         (SELECT array_agg(k.workspace_id ORDER BY k.owner_user_id, k.workspace_id) FROM scope_keys AS k),
         (SELECT coalesce(sum(greatest(a.chunk_count, 0)), 0) FROM allowed AS a)
    INTO allowed_doc_ids, key_owners, key_workspaces, set_chunks;

  IF allowed_doc_ids IS NULL THEN
    RETURN;
  END IF;

  -- One document: its doc_id index scan reaches its few chunks directly (the
  -- plain statement migration 014 keeps for one document); the function's own
  -- SET restores the setting on exit.
  IF cardinality(allowed_doc_ids) = 1 THEN
    PERFORM set_config('enable_indexscan', 'on', true);
  END IF;

  prune := coalesce(prune_df_fraction > 0 AND prune_df_fraction < 1 AND set_chunks > coalesce(prune_min_chunks, 0), false);

  -- Statistics: the folded totals plus the unfolded log, under this call's
  -- one snapshot (the function is STABLE).
  IF use_bm25 OR prune THEN
    SELECT coalesce(sum(x.chunks), 0), coalesce(sum(x.total_length), 0)
      INTO chunk_total, length_total
    FROM (
      SELECT s.chunk_count AS chunks, s.total_length
      FROM %1$I.%3$I AS s
      JOIN unnest(key_owners, key_workspaces) AS k(owner_user_id, workspace_id)
        ON s.owner_user_id = k.owner_user_id AND s.workspace_id = k.workspace_id
      UNION ALL
      SELECT g.chunk_delta, g.length_delta
      FROM %1$I.%7$I AS g
      JOIN unnest(key_owners, key_workspaces) AS k(owner_user_id, workspace_id)
        ON g.owner_user_id = k.owner_user_id AND g.workspace_id = k.workspace_id
    ) AS x;

    chunk_total := greatest(chunk_total, 0);
    length_total := greatest(length_total, 0);

    IF chunk_total > 0 AND length_total > 0 THEN
      average_length := length_total / chunk_total;
    END IF;

    SELECT array_agg(q.lexeme ORDER BY q.lexeme), array_agg(q.df ORDER BY q.lexeme)
      INTO lexemes, dfs
    FROM (
      SELECT l.lexeme,
             greatest(
               coalesce((
                 SELECT sum(t.doc_freq)
                 FROM %1$I.%4$I AS t
                 JOIN unnest(key_owners, key_workspaces) AS k(owner_user_id, workspace_id)
                   ON t.owner_user_id = k.owner_user_id AND t.workspace_id = k.workspace_id
                 WHERE t.lexeme = l.lexeme
               ), 0)
               + coalesce((
                 SELECT sum(g.df_delta)
                 FROM %1$I.%8$I AS g
                 JOIN unnest(key_owners, key_workspaces) AS k(owner_user_id, workspace_id)
                   ON g.owner_user_id = k.owner_user_id AND g.workspace_id = k.workspace_id
                 WHERE g.lexeme = l.lexeme
               ), 0),
               0)::double precision AS df
      FROM unnest(query_lexemes) AS l(lexeme)
    ) AS q;
  END IF;

  -- Lucene's BM25 IDF, always positive: the formula rag/sparse-store.js uses.
  IF use_bm25 THEN
    idfs := ARRAY(
      SELECT ln(1 + (greatest(chunk_total, x.df) - x.df + 0.5) / (x.df + 0.5))
      FROM unnest(dfs) WITH ORDINALITY AS x(df, position)
      ORDER BY x.position
    );
  END IF;

  IF prune THEN
    rare_lexemes := ARRAY(
      SELECT x.lexeme FROM unnest(lexemes, dfs) AS x(lexeme, df)
      WHERE x.df <= prune_df_fraction * chunk_total
      ORDER BY x.lexeme
    );
    -- Rarest first: the every-term pass matches no more chunks than its
    -- rarest term does.
    common_lexemes := ARRAY(
      SELECT x.lexeme FROM unnest(lexemes, dfs) AS x(lexeme, df)
      WHERE x.df > prune_df_fraction * chunk_total
      ORDER BY x.df, x.lexeme
    );
    common_df_total := coalesce((
      SELECT sum(x.df) FROM unnest(lexemes, dfs) AS x(lexeme, df)
      WHERE x.df > prune_df_fraction * chunk_total
    ), 0);
    prune := cardinality(common_lexemes) > 0;
  END IF;

  score_sql := CASE WHEN use_bm25 THEN bm25_sql ELSE rank_cd_sql END;

  IF NOT prune THEN
    EXECUTE format(score_sql, '', candidates)
      INTO found_ids, found_scores
      USING CASE WHEN use_bm25
              THEN array_to_string(ARRAY(
                     SELECT '''' || replace(replace(x.lexeme, E'\\', E'\\\\'), '''', '''''') || ''''
                     FROM unnest(lexemes) AS x(lexeme)), ' | ')::tsquery
              ELSE query END,
            allowed_doc_ids, lexemes, idfs, bm25_k1, bm25_b, average_length, max_rows,
            '{}'::text[], query;
  ELSE
    IF cardinality(rare_lexemes) > 0 THEN
      candidates_path := 'pruned';
      EXECUTE format(score_sql, '', candidates)
        INTO found_ids, found_scores
        USING array_to_string(ARRAY(
                SELECT '''' || replace(replace(x.lexeme, E'\\', E'\\\\'), '''', '''''') || ''''
                FROM unnest(rare_lexemes) AS x(lexeme)), ' | ')::tsquery,
              allowed_doc_ids, lexemes, idfs, bm25_k1, bm25_b, average_length, max_rows,
              '{}'::text[], query;
      found_ids := coalesce(found_ids, '{}');
      found_scores := coalesce(found_scores, '{}');
    ELSE
      candidates_path := 'common_bounded';
    END IF;

    -- A capped pass keeps the first matches in physical order: no parallel
    -- workers, whose interleaving would make the kept set vary run to run.
    IF capped THEN
      parallel_workers := current_setting('max_parallel_workers_per_gather');
      PERFORM set_config('max_parallel_workers_per_gather', '0', true);
    END IF;

    -- Every common term together (only where the cap may cut), then any of them.
    IF capped AND cardinality(common_lexemes) > 1 AND common_df_total > common_term_cap
       AND cardinality(found_ids) < max_rows THEN
      EXECUTE format(score_sql, 'WITH cand AS MATERIALIZED ' || candidates, '(SELECT * FROM cand LIMIT ' || common_term_cap || ')')
        INTO more_ids, more_scores
        USING array_to_string(ARRAY(
                SELECT '''' || replace(replace(x.lexeme, E'\\', E'\\\\'), '''', '''''') || ''''
                FROM unnest(common_lexemes) AS x(lexeme)), ' & ')::tsquery,
              allowed_doc_ids, lexemes, idfs, bm25_k1, bm25_b, average_length, max_rows,
              found_ids, query;
      found_ids := found_ids || coalesce(more_ids, '{}');
      found_scores := found_scores || coalesce(more_scores, '{}');
    END IF;

    IF cardinality(found_ids) < max_rows THEN
      IF candidates_path = 'pruned' THEN
        candidates_path := 'pruned_filled';
      END IF;

      EXECUTE format(
        score_sql,
        CASE WHEN capped THEN 'WITH cand AS MATERIALIZED ' || candidates ELSE '' END,
        CASE WHEN capped THEN '(SELECT * FROM cand LIMIT ' || common_term_cap || ')' ELSE candidates END
      )
        INTO more_ids, more_scores
        USING array_to_string(ARRAY(
                SELECT '''' || replace(replace(x.lexeme, E'\\', E'\\\\'), '''', '''''') || ''''
                FROM unnest(common_lexemes) AS x(lexeme)), ' | ')::tsquery,
              allowed_doc_ids, lexemes, idfs, bm25_k1, bm25_b, average_length, max_rows,
              found_ids, query;
      found_ids := found_ids || coalesce(more_ids, '{}');
      found_scores := found_scores || coalesce(more_scores, '{}');
    END IF;

    IF capped THEN
      PERFORM set_config('max_parallel_workers_per_gather', parallel_workers, true);
    END IF;
  END IF;

  RETURN QUERY
    SELECT r.chunk_id, r.score, candidates_path
    FROM unnest(found_ids, found_scores) AS r(chunk_id, score)
    ORDER BY r.score DESC, r.chunk_id ASC
    LIMIT max_rows;
END
$search$;
  config_name text;
  derived text;
  operation text[];
  statistics_empty boolean;
BEGIN
  IF chunk_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'install_bm25: "%" is not a simple lower-case table name', target_table;
  END IF;

  FOREACH derived IN ARRAY ARRAY[
    scopes_table || '_pkey', terms_table || '_pkey', scope_log_table || '_idx', term_log_table || '_idx',
    length_function, stats_prefix || 'trunc', fold_function, search_function
  ] LOOP
    IF octet_length(derived) > 63 THEN
      RAISE EXCEPTION 'install_bm25: the derived name "%" is longer than 63 bytes', derived;
    END IF;
  END LOOP;

  SELECT format('%I.%I', n.nspname, c.cfgname)
    INTO config_name
  FROM pg_ts_config AS c
  JOIN pg_namespace AS n ON n.oid = c.cfgnamespace
  WHERE c.oid = text_search_config;

  -- Writers wait from here to COMMIT; readers do not.
  EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', qualified_chunks);

  -- A version table created in this transaction has no sparse_length yet
  -- (migration 029 covered the tables that existed then).
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = qualified_chunks::regclass AND attname = 'sparse_length' AND NOT attisdropped
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD COLUMN sparse_length integer', qualified_chunks);
  END IF;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I (
       owner_user_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL,
       chunk_count BIGINT NOT NULL DEFAULT 0,
       total_length BIGINT NOT NULL DEFAULT 0,
       PRIMARY KEY (owner_user_id, workspace_id)
     )',
    schema_name, scopes_table
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I (
       owner_user_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL,
       lexeme TEXT NOT NULL,
       doc_freq BIGINT NOT NULL,
       PRIMARY KEY (owner_user_id, workspace_id, lexeme)
     )',
    schema_name, terms_table
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I (
       owner_user_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL,
       chunk_delta BIGINT NOT NULL,
       length_delta BIGINT NOT NULL
     )',
    schema_name, scope_log_table
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.%I (owner_user_id, workspace_id)',
    scope_log_table || '_idx', schema_name, scope_log_table
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I (
       owner_user_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL,
       lexeme TEXT NOT NULL,
       df_delta BIGINT NOT NULL
     )',
    schema_name, term_log_table
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.%I (owner_user_id, workspace_id, lexeme)',
    term_log_table || '_idx', schema_name, term_log_table
  );

  FOREACH derived IN ARRAY ARRAY[scopes_table, terms_table, scope_log_table, term_log_table] LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', schema_name, derived);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, derived);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', schema_name, derived);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I TO %I USING (%s) WITH CHECK (%s)',
      schema_name, derived, tenant_role, policy_predicate, policy_predicate
    );
  END LOOP;

  -- Chunk length, in the table's own text search configuration.
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION %I.%I() RETURNS trigger LANGUAGE plpgsql AS %L',
    schema_name, length_function,
    format(
      $length$
BEGIN
  NEW.sparse_length := (
    SELECT coalesce(sum(coalesce(cardinality(u.positions), 1)), 0)::integer
    FROM pg_catalog.unnest(pg_catalog.to_tsvector(%L::regconfig, NEW.search_text)) AS u
  );
  RETURN NEW;
END
$length$,
      config_name
    )
  );
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', length_function, qualified_chunks);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF search_text ON %s FOR EACH ROW EXECUTE FUNCTION %I.%I()',
    length_function, qualified_chunks, schema_name, length_function
  );

  -- The fold, keyed per table.
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION %I.%I() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS %L',
    schema_name, fold_function,
    format(
      fold_body, schema_name, scopes_table, terms_table, scope_log_table, term_log_table,
      hashtextextended(schema_name || '.' || fold_function, 0)::text
    )
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%I() FROM PUBLIC', schema_name, fold_function);

  -- Statistics, one statement-level trigger per operation.
  FOREACH operation SLICE 1 IN ARRAY ARRAY[
    ARRAY['ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows',
          'SELECT owner_user_id, workspace_id, search_vector, sparse_length, 1 AS sign FROM new_rows'],
    ARRAY['del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows',
          'SELECT owner_user_id, workspace_id, search_vector, sparse_length, -1 AS sign FROM old_rows'],
    -- A row whose tsvector and scope stay, and whose sparse_length stays or is
    -- only filled in (the backfill writes the count the NULL stood for),
    -- changes no statistic and is left out on both sides.
    ARRAY['upd', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows',
          'SELECT n.owner_user_id, n.workspace_id, n.search_vector, n.sparse_length, 1 AS sign FROM new_rows AS n '
            || 'WHERE NOT EXISTS (SELECT 1 FROM old_rows AS o WHERE o.chunk_id = n.chunk_id '
            || 'AND o.owner_user_id = n.owner_user_id AND o.workspace_id = n.workspace_id '
            || 'AND o.search_vector = n.search_vector '
            || 'AND (o.sparse_length IS NULL OR o.sparse_length IS NOT DISTINCT FROM n.sparse_length)) '
            || 'UNION ALL '
            || 'SELECT o.owner_user_id, o.workspace_id, o.search_vector, o.sparse_length, -1 AS sign FROM old_rows AS o '
            || 'WHERE NOT EXISTS (SELECT 1 FROM new_rows AS n WHERE n.chunk_id = o.chunk_id '
            || 'AND n.owner_user_id = o.owner_user_id AND n.workspace_id = o.workspace_id '
            || 'AND n.search_vector = o.search_vector '
            || 'AND (o.sparse_length IS NULL OR o.sparse_length IS NOT DISTINCT FROM n.sparse_length))']
  ] LOOP
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION %I.%I() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS %L',
      schema_name, stats_prefix || operation[1],
      format(stats_body, schema_name, scope_log_table, term_log_table, operation[4], fold_function)
    );
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I() FROM PUBLIC', schema_name, stats_prefix || operation[1]);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', stats_prefix || operation[1], qualified_chunks);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON %s %s FOR EACH STATEMENT EXECUTE FUNCTION %I.%I()',
      stats_prefix || operation[1], operation[2], qualified_chunks, operation[3],
      schema_name, stats_prefix || operation[1]
    );
  END LOOP;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION %I.%I() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS %L',
    schema_name, stats_prefix || 'trunc',
    format(
      'BEGIN DELETE FROM %1$I.%2$I; DELETE FROM %1$I.%3$I; DELETE FROM %1$I.%4$I; DELETE FROM %1$I.%5$I; RETURN NULL; END',
      schema_name, term_log_table, scope_log_table, terms_table, scopes_table
    )
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%I() FROM PUBLIC', schema_name, stats_prefix || 'trunc');
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', stats_prefix || 'trunc', qualified_chunks);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION %I.%I()',
    stats_prefix || 'trunc', qualified_chunks, schema_name, stats_prefix || 'trunc'
  );

  -- Ranking, as the owner (the plan uses the GIN and doc_id indexes, as
  -- migration 014 explains), EXECUTE for the tenant role only.
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION %I.%I(
       query tsquery, query_vector tsvector, doc_ids text[], max_rows integer, scoring text,
       bm25_k1 double precision, bm25_b double precision, prune_df_fraction double precision,
       prune_min_chunks bigint, common_term_cap integer)
     RETURNS TABLE (chunk_id text, sparse_score double precision, candidate_mode text)
     LANGUAGE plpgsql
     STABLE
     SECURITY DEFINER
     ROWS 20
     SET search_path = pg_catalog, pg_temp
     SET enable_indexscan = off
     AS %L',
    schema_name, search_function,
    format(
      search_body, schema_name, documents_table, scopes_table, terms_table, qualified_chunks, tenant_role,
      scope_log_table, term_log_table
    )
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%I%s FROM PUBLIC', schema_name, search_function, search_signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I%s TO %I', schema_name, search_function, search_signature, tenant_role);

  -- Fold the stored tsvectors into the totals (a new version's table is empty).
  EXECUTE format(
    'SELECT NOT EXISTS (SELECT 1 FROM %1$I.%2$I) AND NOT EXISTS (SELECT 1 FROM %1$I.%3$I)
        AND NOT EXISTS (SELECT 1 FROM %1$I.%4$I) AND NOT EXISTS (SELECT 1 FROM %1$I.%5$I)',
    schema_name, scopes_table, terms_table, scope_log_table, term_log_table
  ) INTO statistics_empty;

  IF statistics_empty THEN
    EXECUTE format(
      'INSERT INTO %1$I.%2$I (owner_user_id, workspace_id, chunk_count, total_length)
       SELECT c.owner_user_id, c.workspace_id, count(*),
              sum(coalesce(c.sparse_length, (SELECT coalesce(sum(coalesce(cardinality(u.positions), 1)), 0)
                                               FROM unnest(c.search_vector) AS u)))
       FROM %3$s AS c
       GROUP BY c.owner_user_id, c.workspace_id',
      schema_name, scopes_table, qualified_chunks
    );
    EXECUTE format(
      'INSERT INTO %1$I.%2$I (owner_user_id, workspace_id, lexeme, doc_freq)
       SELECT c.owner_user_id, c.workspace_id, l.lexeme, count(*)
       FROM %3$s AS c
       CROSS JOIN LATERAL unnest(tsvector_to_array(c.search_vector)) AS l(lexeme)
       GROUP BY c.owner_user_id, c.workspace_id, l.lexeme',
      schema_name, terms_table, qualified_chunks
    );
  END IF;
END
$install$;

REVOKE ALL ON FUNCTION __DOCUMENT_CHUNKS_TABLE___install_bm25(text, regconfig) FROM PUBLIC;

SELECT __DOCUMENT_CHUNKS_TABLE___install_bm25('__DOCUMENT_CHUNKS_TABLE__', '__TEXT_SEARCH_CONFIG__'::regconfig);

DO $migration$
DECLARE
  base_table CONSTANT text := lower('__DOCUMENT_CHUNKS_TABLE__');
  version_row record;
BEGIN
  FOR version_row IN
    SELECT lower(v.chunk_table) AS chunk_table,
           coalesce(nullif(v.index_params ->> 'textSearchConfig', ''), '__TEXT_SEARCH_CONFIG__') AS text_search_config
    FROM __INDEX_VERSIONS_TABLE__ AS v
    WHERE v.status IN ('active', 'building', 'ready')
      AND lower(v.chunk_table) <> base_table
      AND to_regclass(format('%I.%I', current_schema(), lower(v.chunk_table))) IS NOT NULL
    ORDER BY v.version_id
  LOOP
    PERFORM __DOCUMENT_CHUNKS_TABLE___install_bm25(version_row.chunk_table, version_row.text_search_config::regconfig);
  END LOOP;
END
$migration$;
