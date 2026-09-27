-- Two additions to migrations 016 and 017.
--
-- 1. The pointer TTL every instance honours (rag/vector-store-pgvector-versions.js).
--    An API instance caches the active-version pointer for at most the smaller
--    of its own RAG_INDEX_VERSION_POINTER_TTL_MS and pointer_ttl_ms; the
--    lifecycle (`npm run vector:index`) computes the dual-write grace floor and
--    the retire safety window from the larger of its own TTL and
--    pointer_ttl_ms. A CLI and API instances configured with different TTLs
--    therefore still agree on how stale a search can be. The value is the TTL
--    configured in the process that runs this migration; an operator who wants
--    another bound updates the row (raising it takes effect at once, lowering
--    it only once every instance's current cache entry has expired).
--
-- 2. `superseded` on ingest jobs (rag/ingest-job-store.js): a replacement
--    (PUT /documents/:docId) whose content was discarded because a newer
--    replacement of the same document was requested first. The job still
--    succeeds (nothing is left to retry), but GET /ingest-jobs/:jobId says its
--    bytes are not the document's content.

ALTER TABLE __INDEX_VERSIONS_POINTER_TABLE__
  ADD COLUMN IF NOT EXISTS pointer_ttl_ms INTEGER;

UPDATE __INDEX_VERSIONS_POINTER_TABLE__
SET pointer_ttl_ms = __INDEX_VERSION_POINTER_TTL_MS__
WHERE pointer_ttl_ms IS NULL;

ALTER TABLE __INDEX_VERSIONS_POINTER_TABLE__
  DROP CONSTRAINT IF EXISTS __INDEX_VERSIONS_POINTER_TABLE___ttl_positive;

ALTER TABLE __INDEX_VERSIONS_POINTER_TABLE__
  ADD CONSTRAINT __INDEX_VERSIONS_POINTER_TABLE___ttl_positive
    CHECK (pointer_ttl_ms IS NULL OR pointer_ttl_ms > 0);

ALTER TABLE __INGEST_JOBS_TABLE__
  ADD COLUMN IF NOT EXISTS superseded BOOLEAN NOT NULL DEFAULT FALSE;
