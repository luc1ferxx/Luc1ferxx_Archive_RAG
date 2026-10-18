-- The sparse-rank function of migration 014 filters by the tenant policy itself.
--
-- Migration 014's <chunks table>_sparse_rank runs as the table owner (so the
-- planner may use the GIN and doc_id indexes under row-level security) and
-- ranked every chunk of whatever doc ids it was handed. The application only
-- hands it the doc ids the tenant can see (buildTenantSparseSearchSql in
-- rag/vector-store-pgvector.js), but the tenant role holds EXECUTE on it, so
-- any statement running as the tenant could call it directly with another
-- tenant's doc ids and get back the ids of that tenant's matching chunks and
-- their ranks: which documents hold which words, and how many chunks match.
--
-- This migration recreates the function with the same signature, return type,
-- owner, SECURITY DEFINER, pinned search_path, enable_indexscan setting, ROWS
-- estimate and grants. The one change: when the caller acts as the tenant role
-- (current_setting('role'), what SET LOCAL ROLE sets; migration 030's search
-- function makes the same test), the doc ids are first narrowed to the
-- documents that pass the documents table's tenant_isolation predicate of
-- migration 013, written out here because the owner bypasses the policy. Only
-- those ids are ranked, so a foreign doc id contributes nothing, not even a
-- place under max_rows. Called by the owner (or any other role) the function
-- ranks exactly as before. It still returns chunk ids and ranks only.
--
-- The application's own call is unchanged: it still narrows the ids as the
-- tenant before the call and joins the result back to the chunks table as the
-- tenant, so the row policy keeps deciding which rows come back, also on a
-- read replica that has not replayed this migration yet. The lookup inside the
-- function repeats that narrowing as the owner (a bitmap scan of the primary
-- key under the function's enable_indexscan = off, as in migration 030's
-- search function): on a local PostgreSQL 18.6 cluster with 100k chunks, one
-- tenant call with a selective term took 0.49 -> 0.56 ms for 100 doc ids and
-- 2.39 -> 2.77 ms for 1,000 (pgbench means, three alternating runs each).
--
-- Every chunk table has its own function. <base>_install_sparse_rank(table)
-- (owner only, like migration 030's _install_bm25) holds the one definition:
-- this migration runs it for the migration-012 table and for every index
-- version whose table still exists, whatever its status -- a failed version,
-- and a retired one whose drop has not succeeded yet, keep their table and
-- function, and the tenant role may call either. A version created later gets
-- it from renderIndexVersionChunkTableDdl (rag/db-migrations.js), which renders
-- migration 014's template for the table (statistics target included) and then
-- calls the installer in the same statement, so migration 014's unfiltered
-- body is never committed for a new version.

CREATE OR REPLACE FUNCTION __DOCUMENT_CHUNKS_TABLE___install_sparse_rank(target_table text)
RETURNS void
LANGUAGE plpgsql
AS $install$
DECLARE
  schema_name CONSTANT text := current_schema();
  tenant_role CONSTANT text := '__TENANT_ROLE__';
  documents_table CONSTANT text := lower('__DOCUMENTS_TABLE__');
  chunk_table CONSTANT text := lower(target_table);
  rank_function CONSTANT text := lower(target_table) || '_sparse_rank';
  rank_signature CONSTANT text := '(tsquery, text[], integer)';
  -- The function body. %1$L schema, %2$I documents, %3$L the chunk table,
  -- %4$L the tenant role, %5$I schema. The ranking statement is migration
  -- 014's (whitespace aside; test/db-migrations.test.mjs compares them):
  -- dynamic, so every call is planned with its own doc ids and tsquery, with
  -- the identifiers bound at call time.
  rank_body CONSTANT text := $rank$
DECLARE
  tenant_scoped CONSTANT boolean := current_setting('role') = %4$L;
  ranked_doc_ids text[] := doc_ids;
BEGIN
  -- Migration 013's documents policy, which the owner bypasses.
  IF tenant_scoped THEN
    ranked_doc_ids := ARRAY(
      SELECT d.doc_id
      FROM %5$I.%2$I AS d
      WHERE d.doc_id = ANY (doc_ids)
        AND (d.owner_user_id <> '' OR d.workspace_id <> '')
        AND (d.owner_user_id = '' OR d.owner_user_id = current_setting('archive_rag.user_id', true))
        AND (d.workspace_id = '' OR d.workspace_id = current_setting('archive_rag.workspace_id', true))
    );
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT c.chunk_id, ts_rank_cd(c.search_vector, $1, 32)
       FROM %%I.%%I c
      WHERE c.doc_id = ANY ($2)
        AND c.search_vector @@ $1
      ORDER BY 2 DESC, c.chunk_id ASC
      LIMIT $3',
    %1$L,
    %3$L
  )
  USING query, ranked_doc_ids, max_rows;
END
$rank$;
BEGIN
  IF chunk_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'install_sparse_rank: "%" is not a simple lower-case table name', target_table;
  END IF;

  IF octet_length(rank_function) > 63 THEN
    RAISE EXCEPTION 'install_sparse_rank: the derived name "%" is longer than 63 bytes', rank_function;
  END IF;

  IF to_regclass(format('%I.%I', schema_name, chunk_table)) IS NULL THEN
    RAISE EXCEPTION 'install_sparse_rank: table "%" does not exist', chunk_table;
  END IF;

  -- CREATE OR REPLACE keeps an existing function's owner and grants; the
  -- REVOKE and GRANT below restate them for a function created here.
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION %I.%I(query tsquery, doc_ids text[], max_rows integer)
     RETURNS TABLE (chunk_id text, sparse_score real)
     LANGUAGE plpgsql
     STABLE
     SECURITY DEFINER
     ROWS 20
     SET search_path = pg_catalog, pg_temp
     SET enable_indexscan = off
     AS %L',
    schema_name,
    rank_function,
    format(rank_body, schema_name, documents_table, chunk_table, tenant_role, schema_name)
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%I%s FROM PUBLIC', schema_name, rank_function, rank_signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I%s TO %I', schema_name, rank_function, rank_signature, tenant_role);
END
$install$;

REVOKE ALL ON FUNCTION __DOCUMENT_CHUNKS_TABLE___install_sparse_rank(text) FROM PUBLIC;

SELECT __DOCUMENT_CHUNKS_TABLE___install_sparse_rank('__DOCUMENT_CHUNKS_TABLE__');

DO $migration$
DECLARE
  base_table CONSTANT text := lower('__DOCUMENT_CHUNKS_TABLE__');
  version_row record;
BEGIN
  FOR version_row IN
    SELECT lower(v.chunk_table) AS chunk_table
    FROM __INDEX_VERSIONS_TABLE__ AS v
    WHERE lower(v.chunk_table) <> base_table
      AND to_regclass(format('%I.%I', current_schema(), lower(v.chunk_table))) IS NOT NULL
    ORDER BY v.version_id
  LOOP
    PERFORM __DOCUMENT_CHUNKS_TABLE___install_sparse_rank(version_row.chunk_table);
  END LOOP;
END
$migration$;
