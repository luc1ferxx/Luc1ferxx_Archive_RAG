-- Chunk length for Okapi BM25 on the pgvector sparse route (migration 030).
--
-- sparse_length is a chunk's length in indexed terms: the number of positions
-- in its tsvector. Migration 030 installs the BEFORE row trigger that sets it
-- on every insert and every change of search_text; rows written before that
-- keep NULL, and the sparse search function counts their positions whenever
-- BM25 scores them (and a delete of them recounts them). Backfilling the
-- column here would rewrite every row and add a new entry for it to every
-- index, HNSW included -- far more than the one migration a large archive
-- should pay at startup; sparse-length-backfill.mjs does it later, in short
-- batches. Until then BM25 is slower on such rows: on the scale benchmark
-- (100k chunks, all NULL) an exhaustive BM25 search took 3-4x as long (p50).
--
-- This migration only adds the column (a catalog change: no rewrite, and the
-- ACCESS EXCLUSIVE lock is released as soon as it commits), to the
-- migration-012 table and to every live index version's table, so migration
-- 030 never has to upgrade its SHARE ROW EXCLUSIVE lock while it backfills the
-- statistics.

DO $migration$
DECLARE
  base_table CONSTANT text := lower('__DOCUMENT_CHUNKS_TABLE__');
  version_table text;
BEGIN
  EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS sparse_length integer', current_schema(), base_table);

  FOR version_table IN
    SELECT lower(v.chunk_table)
    FROM __INDEX_VERSIONS_TABLE__ v
    WHERE v.status IN ('active', 'building', 'ready')
      AND lower(v.chunk_table) <> base_table
      AND to_regclass(format('%I.%I', current_schema(), lower(v.chunk_table))) IS NOT NULL
    ORDER BY v.version_id
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS sparse_length integer', current_schema(), version_table);
  END LOOP;
END
$migration$;
