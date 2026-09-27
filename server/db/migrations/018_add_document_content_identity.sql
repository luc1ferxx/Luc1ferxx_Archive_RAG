-- Content identity and versions of a document (rag/index.js, rag/doc-registry.js).
--
-- content_sha256 is the SHA-256 of the stored PDF bytes. An upload whose bytes
-- the same tenant (same owner_user_id and workspace_id) already stored returns
-- that document instead of a copy (RAG_INGEST_DEDUP, on by default); the index
-- write takes a transaction-scoped advisory lock on the tenant and hash before
-- it looks, so two identical uploads racing each other still end as one
-- document. Rows from before this migration have no hash until
-- `npm run ingest:jobs -- backfill-hashes` computes it in batches; the
-- migration itself does not read every stored PDF.
--
-- content_version starts at 1 and grows by one with every PUT
-- /documents/:docId, which replaces the document's bytes and chunks in one
-- transaction (pgvector only; the other providers refuse a replacement).
-- content_updated_at orders replacements by the database's clock: an async
-- job's request time (its created_at), or for a synchronous write the time of
-- its commit transaction. An older replacement that finishes after a newer one
-- does not overwrite it (the job succeeds with superseded = true, migration
-- 019). The index-version builder, the activation gate and vector:reindex
-- compare the version too, so a replacement during a build or a reindex is
-- never overwritten with an older read.
--
-- The table's row policy (migration 013) already covers the new columns.

ALTER TABLE __DOCUMENTS_TABLE__
  ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS content_updated_at TIMESTAMPTZ;

ALTER TABLE __DOCUMENTS_TABLE__
  DROP CONSTRAINT IF EXISTS __DOCUMENTS_TABLE___content_version_positive;

ALTER TABLE __DOCUMENTS_TABLE__
  ADD CONSTRAINT __DOCUMENTS_TABLE___content_version_positive CHECK (content_version > 0);

CREATE INDEX IF NOT EXISTS __DOCUMENTS_TABLE___content_sha256_idx
  ON __DOCUMENTS_TABLE__ (owner_user_id, workspace_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;
