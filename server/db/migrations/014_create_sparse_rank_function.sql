-- Full-text candidate ranking for tenant requests (searchPgvectorSparseDocuments).
--
-- Under row-level security PostgreSQL will not evaluate a condition built on a
-- non-leakproof function before the policy's own conditions, so such a
-- condition cannot be an index condition. The full-text match operator (@@,
-- ts_match_vq) is not leakproof, and neither is any other operator a GIN index
-- serves. A tenant's full-text search therefore never used the GIN index on
-- search_vector: over a large document set it fetched and decompressed every
-- chunk of the set (about 140 ms for 1,000 documents at 100k chunks).
--
-- This function runs as the table owner, which ENABLE (not FORCE) row-level
-- security leaves unrestricted, so the planner can combine the GIN and doc_id
-- indexes. It returns only chunk ids and ranks for the doc ids it is given. The
-- caller (buildTenantSparseSearchSql) passes only the doc ids the tenant can see
-- in the documents table -- a primary-key match there is leakproof, so it stays
-- an index lookup under the documents policy -- so another tenant's chunks never
-- take a place under max_rows and the result count reveals nothing about them.
-- It then joins the ids back to the chunks table as the tenant, so the row
-- policy itself still decides which rows come back.
--
-- The query is dynamic so every call is planned with its own doc ids and
-- tsquery. Plain index scans are off inside it: the planner does not charge for
-- decompressing search_vector, so for a large document set it sometimes chose
-- the doc_id index with @@ as a per-row filter, three times slower than
-- BitmapAnd(GIN, doc_id) (p95 150 ms against 53 ms at 1,000 of 2,000 documents,
-- 100k chunks). ROWS tells the caller's join that only max_rows come back. The
-- table is schema-qualified at creation and search_path is pinned, as a
-- SECURITY DEFINER function requires. Only the tenant role may execute it.
--
-- A statistics target of 1000 keeps every common lexeme in the column's
-- statistics: with the default the planner underestimated a query whose words
-- matched 46% of the table and ranked it serially (530 ms instead of 180 ms).
DO $migration$
DECLARE
  -- Unquoted identifiers in migration 012 and the app fold to lower case.
  table_name CONSTANT text := lower('__DOCUMENT_CHUNKS_TABLE__');
  function_name CONSTANT text := lower('__DOCUMENT_CHUNKS_TABLE___sparse_rank');
BEGIN
  EXECUTE format(
    $create$
      CREATE OR REPLACE FUNCTION %1$I.%2$I(query tsquery, doc_ids text[], max_rows integer)
      RETURNS TABLE (chunk_id text, sparse_score real)
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      ROWS 20
      SET search_path = pg_catalog, pg_temp
      SET enable_indexscan = off
      AS $function$
      BEGIN
        RETURN QUERY EXECUTE format(
          'SELECT c.chunk_id, ts_rank_cd(c.search_vector, $1, 32)
             FROM %%I.%%I c
            WHERE c.doc_id = ANY ($2)
              AND c.search_vector @@ $1
            ORDER BY 2 DESC, c.chunk_id ASC
            LIMIT $3',
          %3$L,
          %4$L
        )
        USING query, doc_ids, max_rows;
      END
      $function$
    $create$,
    current_schema(),
    function_name,
    current_schema(),
    table_name
  );

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.%I(tsquery, text[], integer) FROM PUBLIC',
    current_schema(),
    function_name
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION %I.%I(tsquery, text[], integer) TO %I',
    current_schema(),
    function_name,
    '__TENANT_ROLE__'
  );
END
$migration$;

ALTER TABLE __DOCUMENT_CHUNKS_TABLE__ ALTER COLUMN search_vector SET STATISTICS 1000;
